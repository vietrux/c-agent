#!/usr/bin/env node
import { Session } from "./session.js";
import { Agent, type AgentEvents } from "./agent.js";
import { buildRegistry, ToolContext } from "./tools/index.js";
import { skillTool } from "./tools/skill.js";
import { taskTool } from "./tools/task.js";
import { ProcessManager } from "./process/manager.js";
import { resolveProvider } from "./provider/index.js";
import type { Provider } from "./provider/types.js";
import { App } from "./tui/app.js";
import { configuredModelIds, loadSettings } from "./settings.js";
import { PermissionEngine, MODES, type Mode } from "./permissions.js";
import { FileCheckpointer } from "./checkpoint.js";
import { SessionStore } from "./store.js";
import { connectMcpServers } from "./mcp/index.js";
import { loadPrefs } from "./prefs.js";
import { loadSkills } from "./skills.js";
import { loadAgentDefs } from "./subagents.js";
import { SubagentManager } from "./subagent/manager.js";
import { HookRunner } from "./hooks.js";
import { RedactingProvider } from "./provider/redacting.js";
import { Vault, type UndercoverState } from "./utils/redact.js";
import { registerScrubVars } from "./utils/subprocess-env.js";
import { diag } from "./utils/audit.js";

const NOOP_EVENTS: AgentEvents = {
  reasoningDelta() {},
  assistantDelta() {},
  assistantEnd() {},
  toolStart() {},
  toolEnd() {},
  status() {},
  interrupted() {},
};

interface Args {
  continue: boolean;
  resume?: string;
  mode?: Mode;
  model?: string;
}

function parseArgs(argv: string[]): Args {
  const a: Args = { continue: false };
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i];
    if (v === "--continue" || v === "-c") a.continue = true;
    else if (v === "--resume") a.resume = argv[++i];
    else if (v === "--model") a.model = argv[++i];
    else if (v === "--mode") {
      const m = argv[++i];
      if (MODES.includes(m as Mode)) a.mode = m as Mode;
    }
  }
  return a;
}

async function main() {
  // Last-resort crash guards: log diagnostics (no PII) and keep the TUI alive
  // instead of letting an async fault tear down the session.
  process.on("unhandledRejection", (reason) => diag("unhandledRejection", reason));
  process.on("uncaughtException", (err) => diag("uncaughtException", err));

  try {
    process.loadEnvFile(".env");
  } catch {
    // no .env — rely on existing environment
  }

  const args = parseArgs(process.argv.slice(2));
  const cwd = process.cwd();

  const settings = loadSettings(cwd);

  // Scrub configured provider key env-vars (apiKeyEnv) from child processes too,
  // on top of the built-in secret list.
  registerScrubVars([
    settings.provider?.apiKeyEnv,
    ...Object.values(settings.providers).map((p) => p.apiKeyEnv),
  ]);
  const store = new SessionStore(cwd);

  // Build the set of selectable providers: the env default (e.g. NIM) plus any
  // configured in settings (`provider` = active, `providers` = extras). The
  // active provider backs the agent; the /model picker can switch among all.
  const entries: { name: string; provider: Provider; configuredModels?: string[] }[] = [];
  const configModels = configuredModelIds;
  const addEntry = (name: string, p: Provider, configuredModels: string[] = []) => {
    if (!entries.some((e) => e.name === name)) entries.push({ name, provider: p, configuredModels });
  };

  let active: Provider | undefined;
  let activeName = "";
  try {
    // `provider` is the active backend.
    if (settings.provider) {
      activeName = settings.provider.type ?? "default";
      active = resolveProvider(settings.provider).provider;
      addEntry(activeName, active, configModels(settings.provider));
    }
    // `providers` are extras offered in /model; first one is active if no `provider`.
    for (const [name, cfg] of Object.entries(settings.providers)) {
      try {
        const p = resolveProvider(cfg).provider;
        addEntry(name, p, configModels(cfg));
        if (!active) {
          active = p;
          activeName = name;
        }
      } catch {
        /* skip misconfigured extra */
      }
    }
    if (!active) {
      throw new Error(
        "no provider configured — add `provider` (or `providers`) to ~/.c-agent/settings.json",
      );
    }
    // Restore the last provider+model chosen via /model (unless --model overrides).
    const prefs = loadPrefs();
    if (!args.model && prefs.lastProvider) {
      const match = entries.find((e) => e.name === prefs.lastProvider);
      if (match) {
        active = match.provider;
        activeName = match.name;
        if (prefs.lastModel) active.model = prefs.lastModel;
      }
    }
    if (args.model) active.model = args.model;
  } catch (err: any) {
    console.error("error:", err?.message ?? String(err));
    process.exit(1);
  }
  let provider: Provider = active!;

  // Back-compat: C_AGENT_YOLO forces bypass mode.
  const mode: Mode | undefined = process.env.C_AGENT_YOLO ? "bypass" : args.mode;
  const engine = new PermissionEngine(settings.permissions, mode);

  // Resume an existing session or start fresh.
  let session: Session | null = null;
  if (args.resume) session = store.load(args.resume);
  else if (args.continue) session = store.latest();
  if (!session) session = new Session(cwd);
  store.attach(session);

  // Undercover (PII-masking) layer wraps the provider; off unless toggled.
  const undercover: UndercoverState = {
    enabled: !!process.env.C_AGENT_UNDERCOVER,
    vault: new Vault(session.id),
  };
  provider = new RedactingProvider(provider, undercover);

  const pm = new ProcessManager();
  const checkpointer = new FileCheckpointer();
  const registry = buildRegistry();
  const skills = loadSkills(cwd);
  const agentDefs = loadAgentDefs(cwd);
  const hooks = new HookRunner(settings.hooks);

  const toolCtx: ToolContext = {
    pm,
    cwd,
    todos: [],
    fileReads: new Map(),
    engine,
    checkpointer,
    skills,
    hooks,
    provider,
  };

  // Build a subagent: fresh session + agent, optional role from an agent def.
  // Returns the agent (so a background run can abort it) and a `run` that drives
  // it to completion, fires SubagentStop, and yields the final summary text.
  const subMgr = new SubagentManager();
  const buildSubagent = (prompt: string, agentType?: string) => {
    const def = agentType ? agentDefs.get(agentType) : undefined;
    const subRegistry = def?.tools ? registry.subset(def.tools) : registry;
    const subSession = new Session(cwd);
    const label = agentType || "general-purpose";
    const subCtx: ToolContext = {
      ...toolCtx,
      spawn: undefined, // no nested spawning
      spawnBackground: undefined,
      hooks: toolCtx.hooks?.forSubagent(), // tool hooks only; SubagentStop fires below
    };
    // Live monitoring: surface the subagent's tool activity in the parent TUI
    // (the parent only sees the final summary otherwise).
    const mon = toolCtx.monitor;
    const events: AgentEvents = mon
      ? {
          ...NOOP_EVENTS,
          toolStart: (_id, name, input) => {
            const arg = name === "bash" ? String(input?.command ?? "") : "";
            const head = arg.split("\n")[0].slice(0, 80);
            mon(`↳ ${label}: ${name}${head ? " " + head : ""}`);
          },
        }
      : NOOP_EVENTS;
    const subAgent = new Agent(subSession, subRegistry, subCtx, provider, def?.systemPrompt, true);
    const run = async (): Promise<string> => {
      await subAgent.run(prompt, events);
      const last = [...subSession.messages]
        .reverse()
        .find((m) => m.role === "assistant" && m.toolCalls.length === 0);
      const text = last && last.role === "assistant" ? last.content : "";
      // SubagentStop hook (CC parity): fires on the PARENT runner when the
      // subagent finishes, carrying its type + final message.
      if (toolCtx.hooks?.has("SubagentStop"))
        await toolCtx.hooks.run("SubagentStop", { agent_type: label, last_message: text });
      return text;
    };
    return { subAgent, label, run };
  };

  toolCtx.spawn = async (prompt: string, agentType?: string): Promise<string> => {
    const { label, run } = buildSubagent(prompt, agentType);
    toolCtx.monitor?.(`↳ spawned ${label} subagent`);
    return run();
  };

  toolCtx.spawnBackground = (prompt: string, agentType?: string): string => {
    const { subAgent, label, run } = buildSubagent(prompt, agentType);
    return subMgr.start(label, prompt, () => ({
      done: run(),
      abort: () => subAgent.abort(),
    }));
  };

  registry.register(taskTool);
  if (skills.length > 0) registry.register(skillTool);

  const agent = new Agent(session, registry, toolCtx, provider);

  if (hooks.has("SessionStart")) await hooks.run("SessionStart", { cwd, session: session.id });

  // Connect MCP servers (best effort — failures are reported, not fatal).
  let mcpSummary = "no MCP servers configured";
  if (Object.keys(settings.mcpServers).length > 0) {
    const r = await connectMcpServers(registry, settings.mcpServers);
    mcpSummary = r.summary;
    if (r.instructions) toolCtx.mcpInstructions = r.instructions;
    const shutdownMcp = () => r.clients.forEach((c) => c.close());
    process.on("exit", shutdownMcp);
  }

  const app = new App(agent, session, engine, checkpointer, undercover, pm, subMgr, entries, store);
  app.mcpSummary = mcpSummary;
  app.activeProviderName = activeName;
  toolCtx.ask = app.getAsk();
  toolCtx.confirm = app.getConfirm();
  toolCtx.monitor = app.getMonitor();

  const shutdown = () => pm.killAll();
  process.on("exit", shutdown);
  process.on("SIGTERM", () => {
    shutdown();
    process.exit(0);
  });

  app.start();
}

main();

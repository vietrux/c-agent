import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { Session } from "./session.js";
import { ToolRegistry, ToolContext } from "./tools/registry.js";
import { BASE_SYSTEM_A, BASE_SYSTEM_C } from "./.system_prompt.js";
import type { Provider, Usage, NeutralMessage } from "./provider/types.js";

export interface AgentEvents {
  reasoningDelta(text: string): void;
  assistantDelta(text: string): void;
  assistantEnd(): void;
  toolStart(id: string, name: string, input: any): void;
  toolEnd(id: string, result: string, isError: boolean): void;
  status(text: string | null): void;
  interrupted(): void;
  compacted?(note: string): void;
}

const BASE_SYSTEM =
  BASE_SYSTEM_C ||
  "You are c-agent, an interactive CLI tool specialized for coding task.";

const MAX_STEPS = 100;
const MAX_TOOL_RESULT = 64_000; // chars of tool output fed back to the model

// Context budget (in tokens, ~4 chars each). Compact when the transcript estimate
// crosses COMPACT_RATIO of the budget, keeping the most recent turns verbatim.
const CONTEXT_TOKENS = Number(process.env.C_AGENT_CONTEXT_TOKENS) || 160_000;
const COMPACT_RATIO = 0.8;
const KEEP_TURNS = 3; // recent user turns kept verbatim across a compaction

function isAbort(err: any): boolean {
  return err?.name === "AbortError" || /abort/i.test(err?.message ?? "");
}

function estTokens(messages: NeutralMessage[]): number {
  let chars = 0;
  for (const m of messages) {
    if (m.role === "user" || m.role === "note") chars += m.content.length;
    else if (m.role === "assistant") {
      chars += m.content.length;
      for (const tc of m.toolCalls)
        chars += JSON.stringify(tc.input ?? {}).length + tc.name.length;
    } else {
      for (const r of m.results) chars += r.content.length;
    }
  }
  return Math.ceil(chars / 4);
}

function renderTranscript(messages: NeutralMessage[]): string {
  const out: string[] = [];
  for (const m of messages) {
    if (m.role === "note") out.push(`CONTEXT: ${m.content}`);
    else if (m.role === "user") out.push(`USER: ${m.content}`);
    else if (m.role === "assistant") {
      if (m.content) out.push(`ASSISTANT: ${m.content}`);
      for (const tc of m.toolCalls)
        out.push(
          `ASSISTANT used ${tc.name}(${JSON.stringify(tc.input ?? {})})`,
        );
    } else {
      for (const r of m.results)
        out.push(
          `TOOL[${r.isError ? "error" : "ok"}]: ${r.content.slice(0, 2000)}`,
        );
    }
  }
  return out.join("\n");
}

/** Keep head+tail so both the command echo and the tail of long output survive. */
function capResult(text: string): string {
  if (text.length <= MAX_TOOL_RESULT) return text;
  const head = text.slice(0, Math.floor(MAX_TOOL_RESULT * 0.6));
  const tail = text.slice(-Math.floor(MAX_TOOL_RESULT * 0.3));
  return `${head}\n… [${text.length - head.length - tail.length} chars truncated] …\n${tail}`;
}

export class Agent {
  private system: string;
  private ac: AbortController | null = null;
  /** Cumulative wire usage across the whole session (billing-style total). */
  readonly usage: Usage = { input: 0, output: 0, cached: 0 };
  /** Last request's usage = current context-window occupancy (footer display). */
  readonly lastUsage: Usage = { input: 0, output: 0, cached: 0 };

  get model() {
    return this.provider.model;
  }

  setModel(m: string) {
    this.provider.model = m;
  }

  /** Switch the backing provider (model picker across multiple providers). */
  swapProvider(p: Provider) {
    const rp = this.provider as Provider & { setInner?: (p: Provider) => void };
    if (typeof rp.setInner === "function") rp.setInner(p);
    else this.provider = p;
  }

  async listModels(): Promise<string[]> {
    return this.provider.listModels ? this.provider.listModels() : [];
  }

  constructor(
    private session: Session,
    private registry: ToolRegistry,
    private toolCtx: ToolContext,
    private provider: Provider,
    systemBase?: string, // subagents pass their own role prompt
  ) {
    this.system = buildSystem(toolCtx.cwd, toolCtx.skills, systemBase);
  }

  /** Abort the in-flight request, if any. Also kills running foreground tool
   * processes (e.g. bash) so an awaited tool call resolves and the turn can end. */
  abort() {
    this.ac?.abort();
    this.toolCtx.pm.interruptForeground();
  }

  /** Swap the active transcript (used by /resume). */
  setSession(session: Session) {
    this.session = session;
  }

  async run(
    userText: string,
    ev: AgentEvents,
    notes: string[] = [],
  ): Promise<void> {
    let text = userText;
    const hooks = this.toolCtx.hooks;
    if (hooks?.has("UserPromptSubmit")) {
      const r = await hooks.run("UserPromptSubmit", { prompt: userText });
      if (r.context)
        text += `\n\n<hook-context>\n${r.context}\n</hook-context>`;
    }
    this.session.pushUser(text, this.toolCtx.checkpointer?.mark ?? 0, notes);
    await this.loop(ev);
    if (hooks?.has("Stop"))
      await hooks.run("Stop", { messages: this.session.messages.length });
  }

  async resume(ev: AgentEvents): Promise<void> {
    await this.loop(ev);
  }

  /**
   * Autonomous turn triggered by a notify background task finishing: inject the
   * note(s) and let the model act on them — no user message, no checkpoint.
   */
  async notifyRun(ev: AgentEvents, notes: string[]): Promise<void> {
    for (const n of notes) this.session.push({ role: "note", content: n });
    await this.loop(ev);
  }

  /** Estimated tokens of the current transcript. */
  contextTokens(): number {
    return estTokens(this.session.messages);
  }

  /**
   * Summarize older turns into one synthetic note, keeping the last KEEP_TURNS
   * verbatim. Cuts only at user-turn boundaries so tool pairs stay intact.
   * Returns true if it compacted.
   */
  async compact(ev: AgentEvents, signal?: AbortSignal): Promise<boolean> {
    const cps = this.session.checkpoints;
    if (cps.length <= KEEP_TURNS) return false;
    const keepFrom = cps.length - KEEP_TURNS;
    const cutIndex = cps[keepFrom].msgIndex;
    if (cutIndex <= 0) return false;

    const older = this.session.messages.slice(0, cutIndex);
    const kept = this.session.messages.slice(cutIndex);

    ev.status("compacting…");
    let summary: string;
    try {
      const res = await this.provider.stream(
        "You compress a software-engineering chat transcript into a dense handoff note. " +
          "Preserve: the user's goals, decisions made, files changed and why, key facts learned, " +
          "and any unfinished work. Be specific (names, paths). Output prose, no preamble.",
        [
          {
            role: "user",
            content: `Summarize this transcript:\n\n${renderTranscript(older)}`,
          },
        ],
        [],
        { onText: () => {} },
        signal,
      );
      summary = res.text.trim();
    } catch {
      return false; // summarization failed — keep full transcript
    }
    if (!summary) return false;

    const summaryMsg: NeutralMessage = {
      role: "assistant",
      content: `[Summary of earlier conversation]\n${summary}`,
      toolCalls: [],
    };
    // Drop checkpoints: collapsed history is no longer individually rewindable.
    // New turns re-accumulate checkpoints from a clean base.
    this.session.replace([summaryMsg, ...kept], []);
    ev.compacted?.(
      `compacted ${older.length} messages → summary (${KEEP_TURNS} turns kept)`,
    );
    return true;
  }

  private async loop(ev: AgentEvents): Promise<void> {
    this.ac = new AbortController();
    const signal = this.ac.signal;

    for (let step = 0; step < MAX_STEPS; step++) {
      if (signal.aborted) return ev.interrupted();

      if (this.contextTokens() > CONTEXT_TOKENS * COMPACT_RATIO) {
        await this.compact(ev, signal);
        if (signal.aborted) return ev.interrupted();
      }

      ev.status("thinking…");

      let result;
      try {
        result = await this.provider.stream(
          this.system,
          this.session.messages,
          this.registry.specs(),
          {
            onText: (d) => ev.assistantDelta(d),
            onReasoning: (d) => ev.reasoningDelta(d),
          },
          signal,
        );
      } catch (err) {
        ev.assistantEnd();
        if (isAbort(err)) return ev.interrupted();
        throw err;
      }

      const { text, toolCalls, usage } = result;
      this.usage.input += usage.input;
      this.usage.output += usage.output;
      this.usage.cached += usage.cached;
      // Snapshot the latest request: input = full prompt now in the model's
      // context (system + tools + transcript), not a session sum.
      this.lastUsage.input = usage.input;
      this.lastUsage.output = usage.output;
      this.lastUsage.cached = usage.cached;
      ev.assistantEnd();
      this.session.push({ role: "assistant", content: text, toolCalls });

      if (toolCalls.length === 0) {
        ev.status(null);
        return;
      }

      // Dispatch all tool calls concurrently. Approvals serialize themselves via
      // the UI (one prompt at a time); execution overlaps. Results stay in order.
      ev.status(
        toolCalls.length > 1
          ? `running ${toolCalls.length} tools…`
          : `tool: ${toolCalls[0].name}`,
      );
      const results = new Array<{
        id: string;
        content: string;
        isError: boolean;
      }>(toolCalls.length);
      await Promise.all(
        toolCalls.map(async (tc, i) => {
          ev.toolStart(tc.id, tc.name, tc.input);
          if (signal.aborted) {
            results[i] = { id: tc.id, content: "✗ interrupted", isError: true };
            ev.toolEnd(tc.id, "✗ interrupted", true);
            return;
          }
          const res = await this.registry.dispatch(
            tc.name,
            tc.input,
            this.toolCtx,
            signal,
          );
          ev.toolEnd(tc.id, res.text, res.isError ?? false);
          results[i] = {
            id: tc.id,
            content: capResult(res.text),
            isError: res.isError ?? false,
          };
        }),
      );
      this.session.push({ role: "tool", results }); // keep tool_use/tool_result paired
      if (signal.aborted) return ev.interrupted();
    }
    ev.status(null);
    ev.toolEnd("agent", `stopped after ${MAX_STEPS} steps`, true);
  }
}

function buildSystem(
  cwd: string,
  skills?: { name: string; description: string }[],
  base: string = BASE_SYSTEM,
): string {
  const now = new Date();
  const env = [
    `cwd: ${cwd}`,
    `os: ${process.platform}`,
    `shell: ${process.env.SHELL ?? "unknown"}`,
    `date: ${now.toISOString().slice(0, 10)}`,
  ];
  let prompt = `${base}\n\n<environment>\n${env.join("\n")}\n</environment>`;

  if (skills && skills.length > 0) {
    const list = skills.map((s) => `- ${s.name}: ${s.description}`).join("\n");
    prompt +=
      `\n\n<skills>\nThese skills are available. When a task matches one, call the \`skill\` tool ` +
      `with its name to load full instructions BEFORE proceeding.\n${list}\n</skills>`;
  }

  for (const name of ["CAGENT.md", "AGENTS.md"]) {
    const p = resolve(cwd, name);
    if (existsSync(p)) {
      try {
        const content = readFileSync(p, "utf8").trim();
        if (content)
          prompt += `\n\n<project-instructions file="${name}">\n${content}\n</project-instructions>`;
      } catch {
        /* ignore unreadable project file */
      }
      break;
    }
  }
  return prompt;
}

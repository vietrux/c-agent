import { Session } from "./session.js";
import { ToolRegistry, ToolContext } from "./tools/registry.js";
import { StreamingToolScheduler, type ToolEventInfo } from "./tools/scheduler.js";
import { capToolResultsAggregate } from "./tools/result-cap.js";
import { BASE_SYSTEM_A, BEHAVIOR_GUIDANCE_C } from "./profiles.js";
import type { Provider, Usage, NeutralMessage } from "./provider/types.js";
import {
  isAbortError,
  streamWithProviderRetry,
} from "./provider/retry.js";
import { buildSystemPrompt } from "./system-prompt.js";
import { modelContextLimit } from "./models-catalog.js";

export interface AgentEvents {
  reasoningDelta(text: string): void;
  assistantDelta(text: string): void;
  assistantEnd(): void;
  toolQueued?(id: string, name: string, input: any, info: ToolEventInfo): void;
  toolStart(id: string, name: string, input: any, info?: ToolEventInfo): void;
  toolEnd(id: string, result: string, isError: boolean, info?: ToolEventInfo): void;
  status(text: string | null): void;
  interrupted(): void;
  compacted?(note: string, collapsed: boolean): void;
}

const BASE_SYSTEM =
  BASE_SYSTEM_A ||
  "You are c-agent, an interactive CLI tool specialized for coding task.";

// Behavioral guidance appended to every system prompt. Mirrors the higher-signal
// instructions from Claude Code's internal build: comment discipline, verify-
// before-claiming, faithful reporting, collaborator stance, and concrete
// communication/length rules. Kept here (not in the base prompt module) so it
// layers on top of whatever base prompt is loaded.
const BEHAVIOR_GUIDANCE = `# Doing tasks well

- Comments: default to writing NO code comments. Add one only when the logic is genuinely non-obvious — a hidden constraint, a subtle invariant, a workaround for a specific bug. Never narrate what the code does or reference the current task/caller; well-named identifiers and the commit message already cover that.
- Verify before you claim done. Run the project's typecheck / lint / tests (or the relevant command) and confirm they pass before reporting a task complete. If you cannot verify something (e.g. a UI change you can't exercise), say so explicitly instead of claiming success.
- Report outcomes faithfully. Never say something works, passed, or is fixed unless you actually checked. If you are unsure, say you are unsure. Do not overstate results or hide failures, errors, or partial work.
- Be a collaborator, not just an order-taker. If the user is wrong, an approach has a bug, or a simpler/safer path exists, say so directly before proceeding. Surface risks and tradeoffs rather than silently complying.

# Communicating with the user

Your text output is the only thing the user sees — they cannot see your thinking or most tool calls. Communicate like a sharp engineer pairing out loud: brief, concrete, and only when it adds signal.

- Before the first tool call of a turn, state in one sentence what you are about to do.
- Give a short update when you find something, change direction, or hit a blocker. One sentence is almost always enough — silent is worse than brief.
- State results and decisions directly. Do not narrate internal deliberation or list every step you considered.
- End a turn with a one- or two-sentence summary: what changed and what's next. Nothing more.
- Match the response to the task: a simple question gets a direct answer, not headers and sections. Use \`file_path:line\` when pointing at code.

Length anchors (defaults, not hard limits — exceed only when the task truly needs it):
- Keep text between tool calls to about 25 words or fewer.
- Keep a normal response under about 100 words unless the user asks for depth or the content (code, a report) requires more.
- One-word answers are fine when that is the honest, complete answer.

${BEHAVIOR_GUIDANCE_C || ""}`;

const MAX_STEPS = 100;
// Cap on how many concurrency-safe tool calls run at once, so a turn that emits
// dozens of read/grep calls can't spawn an unbounded burst of work.
const MAX_TOOL_CONCURRENCY = Number(process.env.C_AGENT_MAX_TOOL_CONCURRENCY) || 10;
const TOOL_RESULT_BUDGET = Number(process.env.C_AGENT_TOOL_RESULT_BUDGET) || 120_000;

// Context budget (in tokens, ~4 chars each). Compact when the transcript estimate
// crosses COMPACT_RATIO of the budget, keeping the most recent turns verbatim.
// The budget is per-model (models.dev catalog, see contextLimit()); these are the
// fallbacks: an explicit env override wins over everything, else 160k when the
// model is unknown to the catalog.
const CONTEXT_TOKENS_OVERRIDE = process.env.C_AGENT_CONTEXT_TOKENS
  ? Number(process.env.C_AGENT_CONTEXT_TOKENS)
  : undefined;
const CONTEXT_TOKENS_DEFAULT = 160_000;
const COMPACT_RATIO = 0.8;
const KEEP_TURNS = 3; // recent user turns kept verbatim across a compaction
// Microcompaction clears the content of older tool results (keeping the most
// recent few) before resorting to a full summary — far cheaper, and the
// tool_use/tool_result structure stays intact so nothing breaks.
const MICRO_KEEP = 4;
const CLEARED_TOOL_RESULT = "[Old tool result content cleared]";
const MAX_COMPACT_FAILURES = 3; // circuit breaker: stop retrying a failing summary


/** A context-window-overflow error (so we can compact and retry instead of dying). */
function isContextOverflow(err: any): boolean {
  const status = err?.status ?? err?.statusCode;
  if (status === 413) return true;
  const msg = `${err?.message ?? ""} ${err?.error?.message ?? ""}`;
  return /context[\s_]?length|prompt is too long|maximum context|context_length_exceeded|too many (input )?tokens|reduce the (length|amount)/i.test(
    msg,
  );
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

function formatRetryDelay(ms: number): string {
  return `${Math.round(ms / 1000)}s`;
}

// Structured summary prompt for compaction — a dense, sectioned handoff note
// preserves far more usable context than a free-form paragraph.
const COMPACT_SUMMARY_SYSTEM = `You are compacting a software-engineering conversation into a dense handoff note so another session can continue the work with full context. Be specific and concrete: use real names, file paths, signatures, and short code snippets where they matter. Do not summarize away detail that would be needed to resume the work.

Output ONLY the note, wrapped in <summary> tags, with these sections:
1. Primary Request and Intent — what the user is ultimately trying to accomplish, including explicit constraints and preferences.
2. Key Technical Concepts — frameworks, libraries, patterns, and domain facts in play.
3. Files and Code Sections — every file read or changed and why; include important snippets or signatures.
4. Errors and Fixes — failures hit and how each was resolved (or not).
5. Problem Solving — decisions made and the reasoning behind them.
6. Pending Tasks — work explicitly requested but not yet done.
7. Current Work — what was happening immediately before this summary.
8. Next Step — the single most likely next action, if any (omit if unclear).

No preamble, no commentary outside the <summary> tags.`;

export class Agent {
  private systemBase: string;
  private isSubagent: boolean;
  /** Resolved system prompt, computed once (git probe + MCP) then reused. */
  private systemCache: string | null = null;
  private ac: AbortController | null = null;
  /** Cumulative wire usage across the whole session (billing-style total). */
  readonly usage: Usage = { input: 0, output: 0, cached: 0 };
  /** Last request's usage = current context-window occupancy (footer display). */
  readonly lastUsage: Usage = { input: 0, output: 0, cached: 0 };
  // Context-size anchor: the real prompt-token count of the last request and the
  // message count at that point. contextTokens() = anchor + estimate of messages
  // appended since, so system+tool-schema tokens are counted accurately (a raw
  // chars/4 over the transcript ignores them and compacts too late).
  private lastSentTokens = 0;
  private lastSentMsgCount = 0;
  private compactFailures = 0; // consecutive failed summaries (circuit breaker)

  get model() {
    return this.provider.model;
  }

  setModel(m: string) {
    this.provider.model = m;
    this.systemCache = null; // env block names the model — rebuild on next turn
  }

  /** Switch the backing provider (model picker across multiple providers). */
  swapProvider(p: Provider) {
    const rp = this.provider as Provider & { setInner?: (p: Provider) => void };
    if (typeof rp.setInner === "function") rp.setInner(p);
    else this.provider = p;
    this.systemCache = null; // model/backend changed — rebuild on next turn
  }

  async listModels(): Promise<string[]> {
    return this.provider.listModels ? this.provider.listModels() : [];
  }

  /**
   * Token budget for the context window (footer % + compaction trigger).
   * Precedence: explicit env override → the current model's context window from
   * the models.dev catalog → 160k default for models the catalog doesn't know.
   */
  contextLimit(): number {
    if (CONTEXT_TOKENS_OVERRIDE) return CONTEXT_TOKENS_OVERRIDE;
    return modelContextLimit(this.model) ?? CONTEXT_TOKENS_DEFAULT;
  }

  // Valid reasoning levels per wire dialect.
  private static readonly EFFORT_LEVELS: Record<string, readonly string[]> = {
    openai: ["minimal", "low", "medium", "high", "xhigh", "max"],
    anthropic: ["low", "medium", "high", "xhigh", "max"],
  };

  /**
   * Set the reasoning effort for the active provider. Maps to `reasoning_effort`
   * (OpenAI) or `output_config.config` (Anthropic). Returns a status string for
   * the UI; does not throw on bad input.
   */
  setEffort(level: string): string {
    const kind = this.provider.kind;
    const value = level.trim().toLowerCase();
    if (!kind || !this.provider.setRuntimeParams) {
      return "the active provider doesn't support /effort";
    }
    const allowed = Agent.EFFORT_LEVELS[kind];
    if (!allowed) return "the active provider doesn't support /effort";
    if (!value) {
      return `usage: /effort <${allowed.join("|")}>  (current: ${this.currentEffort() ?? "default"})`;
    }
    if (!allowed.includes(value)) {
      return `invalid effort '${value}' — choose: ${allowed.join(", ")}`;
    }
    if (kind === "openai") {
      this.provider.setRuntimeParams({ reasoning_effort: value });
    } else {
      this.provider.setRuntimeParams({ output_config: { config: value } });
    }
    return `effort set to ${value}`;
  }

  /** Current reasoning effort, or null if left at the provider default. */
  currentEffort(): string | null {
    const params = this.provider.getRequestParams?.() ?? {};
    if (this.provider.kind === "openai") {
      return typeof params.reasoning_effort === "string"
        ? params.reasoning_effort
        : null;
    }
    if (this.provider.kind === "anthropic") {
      const cfg = params.output_config?.config;
      return typeof cfg === "string" ? cfg : null;
    }
    return null;
  }

  constructor(
    private session: Session,
    private registry: ToolRegistry,
    private toolCtx: ToolContext,
    private provider: Provider,
    systemBase?: string, // subagents pass their own role prompt
    subagent = false, // subagents get a focused role note, no git-status block
  ) {
    this.systemBase = systemBase || BASE_SYSTEM;
    this.isSubagent = subagent;
  }

  /**
   * Resolve the system prompt, computing the volatile context (git probe, MCP
   * instructions) once and caching it. Invalidated when the model/provider or
   * session changes so the env block and git snapshot stay accurate.
   */
  private async resolveSystem(): Promise<string> {
    if (this.systemCache !== null) return this.systemCache;
    this.systemCache = await buildSystemPrompt({
      base: this.systemBase,
      behavior: BEHAVIOR_GUIDANCE,
      cwd: this.toolCtx.cwd,
      model: this.provider.model,
      skills: this.toolCtx.skills,
      toolNames: this.registry.specs().map((s) => s.name),
      mcpInstructions: this.toolCtx.mcpInstructions,
      pm: this.toolCtx.pm,
      subagent: this.isSubagent,
    });
    return this.systemCache;
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
    this.lastSentTokens = 0; // re-anchor context accounting to the new transcript
    this.lastSentMsgCount = 0;
    this.systemCache = null; // refresh the git snapshot for the resumed session
  }

  async run(
    userText: string,
    ev: AgentEvents,
    notes: string[] = [],
    turnId?: string,
  ): Promise<void> {
    let text = userText;
    const hooks = this.toolCtx.hooks;
    if (hooks?.has("UserPromptSubmit")) {
      const r = await hooks.run("UserPromptSubmit", { prompt: userText });
      if (r.context)
        text += `\n\n<hook-context>\n${r.context}\n</hook-context>`;
    }
    this.session.pushUser(text, this.toolCtx.checkpointer?.mark ?? 0, notes, turnId);
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

  /**
   * Estimated tokens currently in the model's context window. Anchors on the
   * real prompt-token count from the last API response (which already includes
   * the system prompt + tool schemas) and adds a chars/4 estimate only for
   * messages appended since that request. Falls back to a transcript estimate
   * before the first response.
   */
  contextTokens(): number {
    if (this.lastSentTokens > 0) {
      return (
        this.lastSentTokens +
        estTokens(this.session.messages.slice(this.lastSentMsgCount))
      );
    }
    return estTokens(this.session.messages);
  }

  /**
   * Summarize older turns into one synthetic note, keeping the last KEEP_TURNS
   * verbatim. Cuts only at user-turn boundaries so tool pairs stay intact.
   * Returns true if it compacted.
   */
  async compact(ev: AgentEvents, signal?: AbortSignal): Promise<boolean> {
    if (this.compactFailures >= MAX_COMPACT_FAILURES) return false; // circuit breaker
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
      const res = await streamWithProviderRetry(
        this.provider,
        COMPACT_SUMMARY_SYSTEM,
        [
          {
            role: "user",
            content: `Summarize the conversation so far into the structured handoff note described above.\n\n<transcript>\n${renderTranscript(older)}\n</transcript>`,
          },
        ],
        [],
        { onText: () => {} },
        signal,
        {
          onRetry: ({ retryNumber, maxAttempts, delayMs }) =>
            ev.status(
              `provider error; retry ${retryNumber + 1}/${maxAttempts} in ${formatRetryDelay(delayMs)}…`,
            ),
        },
      );
      summary = res.text.trim();
    } catch {
      this.compactFailures++; // count toward the circuit breaker
      return false; // summarization failed — keep full transcript
    }
    if (!summary) {
      this.compactFailures++;
      return false;
    }
    this.compactFailures = 0; // success — reset the breaker

    const summaryMsg: NeutralMessage = {
      role: "assistant",
      content: `[Summary of earlier conversation]\n${summary}`,
      toolCalls: [],
    };
    // Drop checkpoints: collapsed history is no longer individually rewindable.
    // New turns re-accumulate checkpoints from a clean base.
    this.session.replace([summaryMsg, ...kept], []);
    this.lastSentTokens = 0; // transcript shrank — re-anchor on the next request
    this.lastSentMsgCount = 0;
    ev.compacted?.(
      `compacted ${older.length} messages → summary (${KEEP_TURNS} turns kept)`,
      true, // history collapsed + checkpoints dropped — turn markers invalid
    );
    return true;
  }

  /**
   * Clear the content of older tool results (keeping the most recent MICRO_KEEP
   * intact), leaving their tool_use/tool_result structure in place. Cheap way to
   * reclaim context before resorting to a full summary. Returns ~tokens freed.
   */
  private microCompact(): number {
    const msgs = this.session.messages;
    const toolIdx: number[] = [];
    for (let i = 0; i < msgs.length; i++)
      if (msgs[i].role === "tool") toolIdx.push(i);
    if (toolIdx.length <= MICRO_KEEP) return 0;
    const keep = new Set(toolIdx.slice(-MICRO_KEEP));

    let clearedChars = 0;
    for (const i of toolIdx) {
      if (keep.has(i)) continue;
      const m = msgs[i];
      if (m.role !== "tool") continue;
      for (const r of m.results) {
        if (r.content === CLEARED_TOOL_RESULT) continue;
        clearedChars += r.content.length;
        r.content = CLEARED_TOOL_RESULT;
      }
    }
    if (clearedChars === 0) return 0;

    const freed = Math.ceil(clearedChars / 4);
    // The cleared results were part of the last request → shrink the anchor so
    // the context estimate reflects the reclaimed space immediately.
    this.lastSentTokens = Math.max(0, this.lastSentTokens - freed);
    this.session.replace(msgs, this.session.checkpoints); // persist the edit
    return freed;
  }

  private async loop(ev: AgentEvents): Promise<void> {
    this.ac = new AbortController();
    const signal = this.ac.signal;
    let recoveredOverflow = false; // one prompt-too-long recovery per turn

    // Build the system prompt up front (git probe + MCP instructions, cached).
    ev.status("preparing…");
    const system = await this.resolveSystem();
    if (signal.aborted) return ev.interrupted();

    for (let step = 0; step < MAX_STEPS; step++) {
      if (signal.aborted) return ev.interrupted();

      const compactThreshold = this.contextLimit() * COMPACT_RATIO;
      if (this.contextTokens() > compactThreshold) {
        // Cheap pass first: clear old tool output. Only summarize if still over.
        const freed = this.microCompact();
        if (freed > 0)
          ev.compacted?.(
            `micro-compacted: cleared ~${freed} tokens of old tool output`,
            false, // tool results blanked in place — message/turn structure intact
          );
        if (this.contextTokens() > compactThreshold) {
          await this.compact(ev, signal);
        }
        if (signal.aborted) return ev.interrupted();
      }

      ev.status("thinking…");

      // Message count at send time — the anchor for context accounting below.
      const sentMsgCount = this.session.messages.length;
      const toolScheduler = new StreamingToolScheduler(
        this.registry,
        this.toolCtx,
        ev,
        signal,
        {
          maxConcurrency: MAX_TOOL_CONCURRENCY,
          deferUnsafeUntilReleased: true,
        },
      );

      let result;
      try {
        result = await streamWithProviderRetry(
          this.provider,
          system,
          this.session.messages,
          this.registry.specs(),
          {
            onText: (d) => ev.assistantDelta(d),
            onReasoning: (d) => ev.reasoningDelta(d),
            onToolCallReady: (tc) => {
              toolScheduler.add(tc);
            },
          },
          signal,
          {
            shouldRetry: (err) => !isContextOverflow(err),
            onRetry: ({ retryNumber, maxAttempts, delayMs }) =>
              ev.status(
                `provider error; retry ${retryNumber + 1}/${maxAttempts} in ${formatRetryDelay(delayMs)}…`,
              ),
          },
        );
      } catch (err) {
        ev.assistantEnd();
        if (isAbortError(err)) return ev.interrupted();
        // Context overflow: reclaim space (micro then summary) and retry once.
        if (isContextOverflow(err) && !recoveredOverflow) {
          recoveredOverflow = true;
          this.microCompact();
          const did = await this.compact(ev, signal);
          if (signal.aborted) return ev.interrupted();
          if (did) {
            step--; // retry this step with the shrunken transcript
            continue;
          }
        }
        throw err;
      }

      // Esc during the stream can resolve (not throw) with a partial/empty
      // result; treat it as an interrupt and don't commit a malformed turn.
      if (signal.aborted) {
        ev.assistantEnd();
        return ev.interrupted();
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
      // Anchor context accounting on this real count (input includes system +
      // tool schemas + everything sent up to sentMsgCount).
      this.lastSentTokens = usage.input;
      this.lastSentMsgCount = sentMsgCount;
      ev.assistantEnd();
      // Never commit an empty assistant turn (no text, no tool calls): the wire
      // format requires content or tool_calls set, so it 400s on the next send.
      if (text || toolCalls.length > 0)
        this.session.push({ role: "assistant", content: text, toolCalls });

      if (toolCalls.length === 0) {
        ev.status(null);
        return;
      }

      ev.status(
        toolCalls.length > 1
          ? `running ${toolCalls.length} tools…`
          : `tool: ${toolCalls[0].name}`,
      );
      toolScheduler.releaseUnsafe();
      const results = capToolResultsAggregate(
        await toolScheduler.waitFor(toolCalls),
        TOOL_RESULT_BUDGET,
      );
      this.session.push({ role: "tool", results }); // keep tool_use/tool_result paired
      if (signal.aborted) return ev.interrupted();
    }
    ev.status(null);
    ev.toolEnd("agent", `stopped after ${MAX_STEPS} steps`, true);
  }

}

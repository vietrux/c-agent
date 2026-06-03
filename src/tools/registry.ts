import { ProcessManager } from "../process/manager.js";
import type { ToolSpec } from "../provider/types.js";
import type { PermissionEngine } from "../permissions.js";
import type { FileCheckpointer } from "../checkpoint.js";
import type { Skill } from "../skills.js";
import type { HookRunner } from "../hooks.js";

export interface TodoItem {
  text: string;
  status: "pending" | "in_progress" | "done";
}

export type Decision = "allow" | "always" | "deny";

export interface ConfirmRequest {
  name: string;
  preview: string;
}

export interface ToolContext {
  pm: ProcessManager;
  cwd: string;
  todos: TodoItem[];
  /** Ask the user a question via the TUI; resolves with their typed answer. */
  ask?: (question: string) => Promise<string>;
  /** Ask the user to approve a risky tool call. Absent = auto-approve (yolo). */
  confirm?: (req: ConfirmRequest) => Promise<Decision>;
  /** Permission rules + mode. Absent = legacy confirm-only behavior. */
  engine?: PermissionEngine;
  /** Snapshots file state before mutations so rewind can restore it. */
  checkpointer?: FileCheckpointer;
  /** Discovered skills, looked up by the `skill` tool. */
  skills?: Skill[];
  /** Spawn a subagent for a prompt and return its final text. */
  spawn?: (prompt: string, agentType?: string) => Promise<string>;
  /** Lifecycle shell hooks (PreToolUse / PostToolUse). */
  hooks?: HookRunner;
}

export interface ToolResult {
  text: string;
  isError?: boolean;
}

export interface Tool {
  spec: ToolSpec;
  /** Requires user approval before running (mutates the system). */
  risky?: boolean;
  /** `signal` aborts on Esc/interrupt — long in-process tools (glob) honor it. */
  run(input: any, ctx: ToolContext, signal?: AbortSignal): Promise<ToolResult>;
}

function previewOf(name: string, input: any): string {
  if (input?.command) return String(input.command);
  if (input?.path) return String(input.path);
  if (input?.id) return String(input.id);
  try {
    return JSON.stringify(input ?? {}).slice(0, 200);
  } catch {
    return name;
  }
}

export class ToolRegistry {
  private tools = new Map<string, Tool>();
  private allowed = new Set<string>(); // tools the user chose "always" for this session

  register(t: Tool) {
    this.tools.set(t.spec.name, t);
  }

  /** New registry holding only the named tools (for tool-restricted subagents). */
  subset(names: string[]): ToolRegistry {
    const r = new ToolRegistry();
    const want = new Set(names);
    for (const t of this.tools.values()) if (want.has(t.spec.name)) r.register(t);
    return r;
  }

  specs(): ToolSpec[] {
    return [...this.tools.values()].map((t) => t.spec);
  }

  async dispatch(
    name: string,
    input: any,
    ctx: ToolContext,
    signal?: AbortSignal,
  ): Promise<ToolResult> {
    const t = this.tools.get(name);
    if (!t) return { text: `unknown tool: ${name}`, isError: true };
    if (signal?.aborted) return { text: "✗ interrupted", isError: true };

    if (ctx.engine) {
      const verdict = ctx.engine.evaluate(name, input, t.risky ?? false);
      if (verdict === "deny") {
        const why = ctx.engine.mode === "plan" && (t.risky ?? false) ? " (plan mode — no mutations)" : "";
        return { text: `✗ denied${why}`, isError: true };
      }
      if (verdict === "ask") {
        if (!ctx.confirm) return { text: "✗ denied (no approval channel)", isError: true };
        const decision = await ctx.confirm({ name, preview: previewOf(name, input) });
        if (decision === "deny") return { text: "✗ denied by user", isError: true };
        if (decision === "always") ctx.engine.grantAlways(name);
      }
    } else if (t.risky && !this.allowed.has(name) && ctx.confirm) {
      const decision = await ctx.confirm({ name, preview: previewOf(name, input) });
      if (decision === "deny") return { text: "✗ denied by user", isError: true };
      if (decision === "always") this.allowed.add(name);
    }

    if (ctx.hooks?.has("PreToolUse")) {
      const r = await ctx.hooks.run("PreToolUse", { tool: name, input }, name);
      if (r.block) return { text: `✗ blocked by hook: ${r.reason}`, isError: true };
    }

    let result: ToolResult;
    try {
      result = await t.run(input, ctx, signal);
    } catch (err: any) {
      return { text: `tool ${name} failed: ${err?.message ?? String(err)}`, isError: true };
    }

    if (ctx.hooks?.has("PostToolUse")) {
      const r = await ctx.hooks.run("PostToolUse", { tool: name, input, result: result.text }, name);
      if (r.context) result = { ...result, text: `${result.text}\n\n[hook]\n${r.context}` };
    }
    return result;
  }
}

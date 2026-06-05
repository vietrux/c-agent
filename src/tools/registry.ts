import { ProcessManager } from "../process/manager.js";
import type { ToolSpec } from "../provider/types.js";
import type { PermissionEngine, RuleSuggestion } from "../permissions.js";
import type { FileCheckpointer } from "../checkpoint.js";
import type { Skill } from "../skills.js";
import type { HookRunner } from "../hooks.js";
import { capToolResult } from "./result-cap.js";

export interface TodoItem {
  text: string;
  status: "pending" | "in_progress" | "done";
}

export type Decision = "allow" | "always" | "deny";

export interface ConfirmResult {
  decision: Decision;
  /** User's optional reason when denying — returned to the model as context. */
  feedback?: string;
}

export interface ConfirmRequest {
  name: string;
  preview: string;
  /**
   * Per-command/per-target rule to grant on "always". null = grant whole tool.
   * Populated by the engine's suggestRule() for bash; absent for other tools.
   */
  suggestion?: RuleSuggestion | null;
}

export interface ToolContext {
  pm: ProcessManager;
  cwd: string;
  todos: TodoItem[];
  /** Ask the user a question via the TUI; resolves with their typed answer. */
  ask?: (question: string) => Promise<string>;
  /** Ask the user to approve a risky tool call. Absent = auto-approve (yolo). */
  confirm?: (req: ConfirmRequest) => Promise<ConfirmResult>;
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
  /**
   * Safe to run in parallel with other concurrency-safe calls: read-only, no
   * side effects, order-independent (read/grep/glob/…). Defaults to false —
   * write/exec tools run serially so parallel calls can't corrupt shared state.
   */
  concurrencySafe?: boolean;
  /**
   * Per-input override: return true when THIS specific call is provably
   * side-effect-free (e.g. `bash ls` vs `bash rm`). A true result both marks the
   * call concurrency-safe AND downgrades `risky` to false (skips the permission
   * prompt). SECURITY: only return true when certain — a wrong true lets a
   * mutating call run unapproved. May throw; callers treat a throw as "not safe".
   */
  readOnly?(input: any): boolean;
  /**
   * Max chars of this tool's result fed to the model before the full output is
   * spilled to disk and replaced with a preview + path. Default 64k. Use
   * Infinity for tools whose output must never be persisted (e.g. read).
   */
  maxResultChars?: number;
  /** `signal` aborts on Esc/interrupt — long in-process tools (glob) honor it. */
  run(input: any, ctx: ToolContext, signal?: AbortSignal): Promise<ToolResult>;
}

/** True if this specific call is provably read-only. Never throws. */
function isCallReadOnly(t: Tool, input: any): boolean {
  if (!t.readOnly) return false;
  try {
    return t.readOnly(input) === true;
  } catch {
    return false; // classifier error → treat as NOT read-only (conservative)
  }
}

function jsonType(v: any): string {
  if (Array.isArray(v)) return "array";
  if (v === null) return "null";
  return typeof v;
}

function typeMatches(want: string, v: any): boolean {
  switch (want) {
    case "string":
      return typeof v === "string";
    case "number":
    case "integer":
      return typeof v === "number";
    case "boolean":
      return typeof v === "boolean";
    case "array":
      return Array.isArray(v);
    case "object":
      return typeof v === "object" && v !== null && !Array.isArray(v);
    default:
      return true; // unknown/unsupported schema type → don't block
  }
}

/**
 * Boundary check for model-supplied tool arguments against the tool's JSON
 * schema. Validates the common subset tools declare (object with typed
 * properties + `required`); lenient on anything it doesn't understand so it
 * never rejects a structurally-valid call. Returns an error string, or null.
 */
export function validateToolInput(schema: any, input: any): string | null {
  if (
    !schema ||
    schema.type !== "object" ||
    typeof schema.properties !== "object"
  )
    return null;
  if (input === undefined || input === null) {
    return (schema.required ?? []).length > 0
      ? `expected an object of arguments`
      : null;
  }
  if (typeof input !== "object" || Array.isArray(input))
    return `expected an object of arguments, got ${jsonType(input)}`;

  for (const req of schema.required ?? []) {
    if (input[req] === undefined || input[req] === null)
      return `missing required parameter "${req}"`;
  }
  for (const [key, val] of Object.entries(input)) {
    const prop = schema.properties[key];
    if (!prop || typeof prop.type !== "string") continue; // extra/untyped prop
    if (val === undefined || val === null) continue; // optional, absent
    if (!typeMatches(prop.type, val))
      return `parameter "${key}" must be ${prop.type}, got ${jsonType(val)}`;
  }
  return null;
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

/** Build the tool error text for a user denial, including optional feedback. */
function deniedText(feedback?: string): string {
  if (!feedback?.trim()) return "✗ denied by user";
  return `✗ denied by user\nUser feedback: ${feedback.trim()}`;
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
    for (const t of this.tools.values())
      if (want.has(t.spec.name)) r.register(t);
    return r;
  }

  specs(): ToolSpec[] {
    return [...this.tools.values()].map((t) => t.spec);
  }

  /**
   * True if the named call is side-effect-free → safe to parallelize. Checks the
   * per-input `readOnly` predicate first (e.g. `bash ls`), then the static
   * `concurrencySafe` flag.
   */
  isConcurrencySafe(name: string, input?: any): boolean {
    const t = this.tools.get(name);
    if (!t) return false;
    if (isCallReadOnly(t, input)) return true;
    return t.concurrencySafe ?? false;
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

    // Validate the model-supplied arguments against the tool's schema before
    // doing anything (permission prompts, side effects). A clear error lets the
    // model self-correct instead of the tool blowing up on garbage input.
    const invalid = validateToolInput(t.spec.parameters, input);
    if (invalid)
      return {
        text: `✗ invalid arguments for ${name}: ${invalid}`,
        isError: true,
      };

    // A call proven read-only (e.g. `bash ls`) is downgraded from risky → not
    // risky, so it skips the prompt like read/grep. User `deny` rules still
    // apply (the engine checks deny before this flag).
    const risky = isCallReadOnly(t, input) ? false : (t.risky ?? false);

    if (ctx.engine) {
      const verdict = ctx.engine.evaluate(name, input, risky);
      if (verdict === "deny") {
        const why =
          ctx.engine.mode === "plan" && risky
            ? " (plan mode — no mutations)"
            : "";
        return { text: `✗ denied${why}`, isError: true };
      }
      if (verdict === "ask") {
        if (!ctx.confirm)
          return { text: "✗ denied (no approval channel)", isError: true };
        const suggestion = ctx.engine.suggestRule(name, input);
        const result = await ctx.confirm({
          name,
          preview: previewOf(name, input),
          suggestion,
        });
        if (result.decision === "deny")
          return { text: deniedText(result.feedback), isError: true };
        if (result.decision === "always") {
          if (suggestion) ctx.engine.grantRule(suggestion.spec, name);
          else ctx.engine.grantAlways(name);
        }
      }
    } else if (risky && !this.allowed.has(name) && ctx.confirm) {
      const result = await ctx.confirm({
        name,
        preview: previewOf(name, input),
      });
      if (result.decision === "deny")
        return { text: deniedText(result.feedback), isError: true };
      if (result.decision === "always") this.allowed.add(name);
    }

    if (ctx.hooks?.has("PreToolUse")) {
      const r = await ctx.hooks.run("PreToolUse", { tool: name, input }, name);
      if (r.block)
        return { text: `✗ blocked by hook: ${r.reason}`, isError: true };
    }

    let result: ToolResult;
    try {
      result = await t.run(input, ctx, signal);
    } catch (err: any) {
      return {
        text: `tool ${name} failed: ${err?.message ?? String(err)}`,
        isError: true,
      };
    }

    if (ctx.hooks?.has("PostToolUse")) {
      const r = await ctx.hooks.run(
        "PostToolUse",
        { tool: name, input, result: result.text },
        name,
      );
      if (r.context)
        result = { ...result, text: `${result.text}\n\n[hook]\n${r.context}` };
    }

    // Cap the model-facing result: oversized output spills to disk with a
    // preview + path instead of silently dropping content.
    return {
      ...result,
      text: capToolResult(result.text, t.maxResultChars),
    };
  }
}

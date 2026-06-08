import { spawn } from "node:child_process";
import type { HookConfig, HookDef, HookEvent } from "./settings.js";
import { subprocessEnv } from "./utils/subprocess-env.js";

export interface HookOutcome {
  block: boolean; // PreToolUse: deny the action
  reason?: string; // why blocked
  context?: string; // extra text to feed back (stdout of the hook)
}

const HOOK_TIMEOUT_MS = 30_000;

/** Run a single shell command with JSON payload on stdin; capture stdout/stderr/exit. */
function runCommand(
  command: string,
  payload: unknown,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(command, { shell: true, env: subprocessEnv() });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGTERM"), HOOK_TIMEOUT_MS);
    child.stdout.on("data", (c) => (stdout += c.toString()));
    child.stderr.on("data", (c) => (stderr += c.toString()));
    child.on("error", (e) => {
      clearTimeout(timer);
      resolve({ code: 1, stdout, stderr: stderr + String(e) });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
    // A hook that ignores stdin and exits fast (e.g. `exit 1`) closes the pipe
    // before we finish writing — swallow the resulting EPIPE.
    child.stdin.on("error", () => {});
    try {
      child.stdin.write(JSON.stringify(payload));
      child.stdin.end();
    } catch {
      /* stdin may already be closed */
    }
  });
}

/**
 * Runs user-configured shell hooks on lifecycle events.
 * PreToolUse can block a tool (nonzero exit). UserPromptSubmit / PostToolUse stdout
 * is fed back as extra context. Tool-event hooks honor an optional name `matcher` regex.
 */
export class HookRunner {
  constructor(private hooks: HookConfig) {}

  has(event: HookEvent): boolean {
    return (this.hooks[event]?.length ?? 0) > 0;
  }

  /**
   * Hooks a subagent should run: tool lifecycle only. The main-agent prompt/Stop
   * events don't apply inside a subagent — its completion fires SubagentStop on
   * the parent runner instead (mirrors Claude Code's Stop vs SubagentStop split).
   */
  forSubagent(): HookRunner {
    const { PreToolUse, PostToolUse } = this.hooks;
    return new HookRunner({ PreToolUse, PostToolUse });
  }

  private matching(event: HookEvent, toolName?: string): HookDef[] {
    const defs = this.hooks[event] ?? [];
    if (toolName === undefined) return defs;
    return defs.filter((d) => {
      if (!d.matcher || d.matcher === "*") return true;
      try {
        return new RegExp(d.matcher).test(toolName);
      } catch {
        return d.matcher === toolName;
      }
    });
  }

  async run(event: HookEvent, payload: Record<string, unknown>, toolName?: string): Promise<HookOutcome> {
    const defs = this.matching(event, toolName);
    const contexts: string[] = [];
    for (const def of defs) {
      const { code, stdout, stderr } = await runCommand(def.command, { event, ...payload });
      if (event === "PreToolUse" && code !== 0) {
        return { block: true, reason: (stderr || stdout || "blocked by hook").trim() };
      }
      const out = stdout.trim();
      if (out) contexts.push(out);
    }
    return { block: false, context: contexts.length ? contexts.join("\n") : undefined };
  }
}

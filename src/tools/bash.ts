import type { Tool } from "./registry.js";
import { isReadOnlyBashCommand } from "./bash-classifier.js";

// Commands that should never be auto-backgrounded on timeout: a slow `sleep`
// is almost always meant to block, so killing it is the right call.
const NO_AUTO_BACKGROUND = new Set(["sleep"]);

/** Auto-background a long foreground command unless it's disallowed or disabled. */
function autoBackgroundAllowed(command: string): boolean {
  if (process.env.C_AGENT_DISABLE_BG) return false;
  const base = command.trim().split(/\s+/)[0]?.split("/").pop() ?? "";
  return !NO_AUTO_BACKGROUND.has(base);
}

export const bashTool: Tool = {
  risky: true,
  // Provably read-only invocations (`ls`, `cat`, `grep`, `git log`, …) are
  // downgraded: they skip the prompt and may run concurrently. Conservative —
  // anything with a redirect/pipe/chain/substitution stays risky. Deny rules
  // still apply. See bash-classifier.ts for the security model.
  readOnly: (input) => isReadOnlyBashCommand(String(input?.command ?? "")),
  spec: {
    name: "bash",
    description:
      "Run a shell command in the project shell. Prefer dedicated tools when they fit — " +
      "they are safer and clearer: read (not cat/head/tail), edit or write (not sed/awk/echo >), " +
      "grep (not grep/rg directly), glob (not find/ls -R). " +
      "Quote any path containing spaces. Do not use interactive flags (e.g. -i) or commands that " +
      "need a TTY. Avoid scanning the whole filesystem (no `find /`). " +
      "Set background=true for long-running processes (servers, watchers): it returns a proc id " +
      "immediately — follow it with proc_read, or manage it via proc_list / proc_tail / proc_kill. " +
      "A foreground command that exceeds timeout_ms is moved to the background automatically " +
      "(except `sleep`) and keeps running — you are notified when it finishes. " +
      "Never commit or push with git unless the user explicitly asked.",
    parameters: {
      type: "object",
      properties: {
        command: { type: "string", description: "Shell command to run" },
        background: {
          type: "boolean",
          description: "Run detached; return proc id without waiting for exit",
        },
        notify: {
          type: "boolean",
          description:
            "Only with background. If true, you are woken automatically when the command finishes " +
            "so you can act on its result. If false, the result is surfaced on the next user turn.",
        },
        timeout_ms: {
          type: "number",
          description: "Foreground budget in ms before auto-backgrounding (default 120000)",
        },
      },
      required: ["command"],
    },
  },
  async run(input, ctx) {
    const background = input.background === true;
    const r = await ctx.pm.run({
      command: input.command,
      cwd: ctx.cwd,
      background,
      notify: input.notify === true,
      timeoutMs: input.timeout_ms ?? 120_000,
      autoBackground: !background && autoBackgroundAllowed(input.command),
    });

    if (r.background) {
      const logHint = r.outputPath ? ` Full log on disk: ${r.outputPath}.` : "";
      const head = r.autoBackgrounded
        ? `[${r.id}] exceeded the ${(input.timeout_ms ?? 120_000) / 1000}s foreground budget and was ` +
          `moved to the background — still running. You'll be notified when it finishes.`
        : `[${r.id}] started in background (running=${r.running}).`;
      return {
        text:
          `${head} Read new output incrementally with proc_read id=${r.id}.${logHint}\n` +
          `initial output:\n${r.output || "(none yet)"}`,
      };
    }

    const status = r.timedOut
      ? `timed out (SIGTERM)`
      : `exit=${r.exitCode}${r.signal ? ` signal=${r.signal}` : ""}`;
    return {
      text: `[${r.id}] ${status}\n${r.output || "(no output)"}`,
      isError: r.exitCode !== 0 && !r.timedOut ? true : false,
    };
  },
};

export const procListTool: Tool = {
  concurrencySafe: true,
  spec: {
    name: "proc_list",
    description: "List all spawned processes with id, command, running state, exit code.",
    parameters: { type: "object", properties: {} },
  },
  async run(_input, ctx) {
    const list = ctx.pm.list();
    if (list.length === 0) return { text: "no processes" };
    const lines = list.map(
      (p) =>
        `${p.id}\t${p.running ? "RUNNING" : `exited(${p.exitCode})`}\t${p.background ? "bg" : "fg"}\t${p.command}`,
    );
    return { text: lines.join("\n") };
  },
};

export const procReadTool: Tool = {
  concurrencySafe: true,
  spec: {
    name: "proc_read",
    description:
      "Read NEW output from a process since your last proc_read (incremental cursor — repeated " +
      "calls never re-show the same lines). Optional regex filter keeps only matching lines. Use " +
      "this to follow a background or long-running command. For a full snapshot use proc_tail.",
    parameters: {
      type: "object",
      properties: {
        id: { type: "string" },
        filter: { type: "string", description: "only return lines matching this regex" },
      },
      required: ["id"],
    },
  },
  async run(input, ctx) {
    const r = ctx.pm.read(input.id, input.filter);
    if (r === null) return { text: `no such process: ${input.id}`, isError: true };
    const head = r.dropped > 0 ? `… (${r.dropped} earlier lines dropped from buffer)\n` : "";
    const tail = r.running ? "" : "\n[process exited]";
    return { text: head + (r.text || "(no new output)") + tail };
  },
};

export const procTailTool: Tool = {
  concurrencySafe: true,
  spec: {
    name: "proc_tail",
    description: "Get the last N output lines of a process by id (snapshot, not incremental).",
    parameters: {
      type: "object",
      properties: {
        id: { type: "string" },
        lines: { type: "number", description: "default 50" },
      },
      required: ["id"],
    },
  },
  async run(input, ctx) {
    const out = ctx.pm.tail(input.id, input.lines ?? 50);
    if (out === null) return { text: `no such process: ${input.id}`, isError: true };
    return { text: out || "(no output)" };
  },
};

export const procKillTool: Tool = {
  risky: true,
  spec: {
    name: "proc_kill",
    description: "Kill a running process (and its whole process group) by id (SIGTERM by default).",
    parameters: {
      type: "object",
      properties: {
        id: { type: "string" },
        signal: { type: "string", description: "e.g. SIGTERM, SIGKILL" },
      },
      required: ["id"],
    },
  },
  async run(input, ctx) {
    const ok = ctx.pm.kill(input.id, input.signal);
    return { text: ok ? `killed ${input.id}` : `could not kill ${input.id} (not running?)` };
  },
};

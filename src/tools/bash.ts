import type { Tool } from "./registry.js";

export const bashTool: Tool = {
  risky: true,
  spec: {
    name: "bash",
    description:
      "Run a shell command in the project shell. Prefer dedicated tools when they fit — " +
      "they are safer and clearer: read (not cat/head/tail), edit or write (not sed/awk/echo >), " +
      "grep (not grep/rg directly), glob (not find/ls -R). " +
      "Quote any path containing spaces. Do not use interactive flags (e.g. -i) or commands that " +
      "need a TTY. Avoid scanning the whole filesystem (no `find /`). " +
      "Set background=true for long-running processes (servers, watchers): it returns a proc id " +
      "immediately — manage it via proc_tail / proc_list / proc_kill. " +
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
          description: "Foreground kill timeout in ms (default 120000)",
        },
      },
      required: ["command"],
    },
  },
  async run(input, ctx) {
    const r = await ctx.pm.run({
      command: input.command,
      cwd: ctx.cwd,
      background: input.background === true,
      notify: input.notify === true,
      timeoutMs: input.timeout_ms ?? 120_000,
    });
    if (r.background) {
      return {
        text:
          `[${r.id}] started in background (running=${r.running}).\n` +
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

export const procTailTool: Tool = {
  spec: {
    name: "proc_tail",
    description: "Get the last N output lines of a process by id.",
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
    description: "Kill a running process by id (SIGTERM by default).",
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

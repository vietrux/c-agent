import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { release as osRelease, type as osType, version as osVersion } from "node:os";
import type { ProcessManager } from "./process/manager.js";

/**
 * System-prompt builder, modeled on Claude Code's getSystemPrompt pipeline:
 * the prompt is assembled from discrete, null-filterable sections — a static
 * instruction prefix plus a volatile context block (git status, MCP server
 * instructions) computed once per session. Keeping the volatile parts in their
 * own trailing block means the large static prefix stays byte-stable, so the
 * provider's prompt-cache breakpoint keeps hitting across turns.
 */

const MAX_GIT_STATUS_CHARS = 2000;

export interface SystemPromptOptions {
  /** Role/identity prompt (base for the main agent, a custom role for subagents). */
  base: string;
  /** Behavioral guidance shared by every agent. */
  behavior: string;
  cwd: string;
  /** Active model id — drives the env block + knowledge-cutoff line. */
  model: string;
  skills?: { name: string; description: string }[];
  /** Names of the tools currently exposed to the model (tool-aware guidance). */
  toolNames: string[];
  /** Concatenated instructions advertised by connected MCP servers, if any. */
  mcpInstructions?: string;
  /** Used to probe git state (status/branch/commits) at session start. */
  pm: ProcessManager;
  /** Subagents get a focused role note instead of the full git-status block. */
  subagent?: boolean;
}

/** Per-model knowledge-cutoff date, best-effort. Null when unknown. */
export function knowledgeCutoff(model: string): string | null {
  const m = model.toLowerCase();
  if (/claude-(opus|sonnet|haiku)-4/.test(m)) return "early 2025";
  if (m.includes("claude-3-5") || m.includes("claude-3.5")) return "April 2024";
  if (m.includes("gpt-4.1") || m.includes("gpt-4o") || m.includes("o1") || m.includes("o3"))
    return "October 2023";
  if (m.includes("llama-3") || m.includes("llama3")) return "December 2023";
  return null;
}

/** "Darwin 25.3.0" / "Linux 6.8.0" / "Windows 11 …" — byte-compatible with `uname -sr`. */
export function osVersionString(): string {
  if (process.platform === "win32") return `${osVersion()} ${osRelease()}`;
  return `${osType()} ${osRelease()}`;
}

function shellInfoLine(): string {
  const shell = process.env.SHELL || "unknown";
  const name = shell.includes("zsh")
    ? "zsh"
    : shell.includes("bash")
      ? "bash"
      : shell.includes("fish")
        ? "fish"
        : shell;
  if (process.platform === "win32")
    return `Shell: ${name} (use Unix shell syntax, not Windows — e.g. /dev/null not NUL, forward slashes in paths)`;
  return `Shell: ${name}`;
}

interface GitInfo {
  isGit: boolean;
  isWorktree: boolean;
  /** Pre-rendered <git-status> block, or null when not a repo. */
  status: string | null;
}

/** Run a git command; return trimmed stdout, or "" on any non-zero/spawn error. */
async function git(pm: ProcessManager, cwd: string, command: string): Promise<string> {
  try {
    const r = await pm.run({ command, cwd, timeoutMs: 5_000 });
    return r.exitCode === 0 ? r.output.trim() : "";
  } catch {
    return "";
  }
}

async function detectMainBranch(pm: ProcessManager, cwd: string): Promise<string> {
  const head = await git(pm, cwd, "git rev-parse --abbrev-ref origin/HEAD");
  if (head && head !== "origin/HEAD") return head.replace(/^origin\//, "");
  for (const b of ["main", "master"]) {
    const r = await git(pm, cwd, `git rev-parse --verify ${b}`);
    if (r) return b;
  }
  return "main";
}

/**
 * Probe git state once at session start: branch, main branch, user, short
 * status (truncated), and recent commits — the same snapshot Claude Code
 * prepends. Returns isGit/isWorktree for the environment block too.
 */
async function probeGit(pm: ProcessManager, cwd: string): Promise<GitInfo> {
  const inside = await git(pm, cwd, "git rev-parse --is-inside-work-tree");
  if (inside !== "true") return { isGit: false, isWorktree: false, status: null };

  const [branch, gitDir, rawStatus, log, user, mainBranch] = await Promise.all([
    git(pm, cwd, "git rev-parse --abbrev-ref HEAD"),
    git(pm, cwd, "git rev-parse --git-dir"),
    git(pm, cwd, "git --no-optional-locks status --short"),
    git(pm, cwd, "git --no-optional-locks log --oneline -n 5"),
    git(pm, cwd, "git config user.name"),
    detectMainBranch(pm, cwd),
  ]);

  const isWorktree = gitDir.includes("/worktrees/");
  const status =
    rawStatus.length > MAX_GIT_STATUS_CHARS
      ? rawStatus.slice(0, MAX_GIT_STATUS_CHARS) +
        '\n... (truncated — it exceeds 2k characters; run "git status" with the bash tool for the full list)'
      : rawStatus;

  const block = [
    "This is the git status at the start of the conversation. Note that this status is a snapshot in time, and will not update during the conversation.",
    `Current branch: ${branch || "(detached)"}`,
    `Main branch (you will usually use this for PRs): ${mainBranch}`,
    ...(user ? [`Git user: ${user}`] : []),
    `Status:\n${status || "(clean)"}`,
    `Recent commits:\n${log || "(none)"}`,
  ].join("\n\n");

  return { isGit: true, isWorktree, status: `<git-status>\n${block}\n</git-status>` };
}

function environmentSection(opts: SystemPromptOptions, git: GitInfo): string {
  const cutoff = knowledgeCutoff(opts.model);
  const items = [
    `Working directory: ${opts.cwd}`,
    git.isWorktree
      ? "This is a git worktree (an isolated copy of the repository). Run commands from here; do not cd to the original repository root."
      : null,
    `Is a git repository: ${git.isGit ? "yes" : "no"}`,
    `Platform: ${process.platform}`,
    shellInfoLine(),
    `OS version: ${osVersionString()}`,
    `Today's date: ${new Date().toISOString().slice(0, 10)}`,
    `You are powered by the model ${opts.model}.`,
    cutoff ? `Assistant knowledge cutoff is ${cutoff}.` : null,
  ].filter((x): x is string => x !== null);
  return `<environment>\n${items.join("\n")}\n</environment>`;
}

function skillsSection(skills?: SystemPromptOptions["skills"]): string | null {
  if (!skills || skills.length === 0) return null;
  const list = skills.map((s) => `- ${s.name}: ${s.description}`).join("\n");
  return (
    "<skills>\nThese skills are available. When a task matches one or more skills, call the `skill` " +
    "tool to load full instructions BEFORE proceeding. If multiple skills match, load them together " +
    `with \`names: [...]\` and compose their instructions for the task.\n${list}\n</skills>`
  );
}

/** Tool-usage guidance tailored to the tools actually exposed this session. */
function toolsSection(toolNames: string[]): string | null {
  const has = (n: string) => toolNames.includes(n);
  const bullets: string[] = [];
  if (has("read"))
    bullets.push(
      "Read a file before you edit or overwrite it, and prefer `edit`/`multi_edit` over `write` for changes to existing files.",
    );
  if (has("grep") || has("glob"))
    bullets.push(
      "Search with `grep` (file contents) and `glob` (file names) instead of `bash` grep/find/ls — they are faster and respect ignore rules.",
    );
  if (has("bash"))
    bullets.push(
      "Use `bash` for commands, but prefer the dedicated file tools over `cat`/`sed`/`echo >`. Quote any path that contains spaces, and never run interactive (`-i`) commands.",
    );
  if (has("task"))
    bullets.push(
      "Delegate large, self-contained investigations to the `task` subagent tool to keep your own context focused.",
    );
  if (has("todo"))
    bullets.push("For multi-step work, track progress with the `todo` tool so nothing is dropped.");
  if (has("tool_search"))
    bullets.push(
      "Some specialty tools (e.g. `web_fetch`, `encode_decode`, `notes`) are deferred — activate them with `tool_search` when you need them.",
    );
  if (bullets.length === 0) return null;
  return ["# Using your tools", ...bullets.map((b) => `- ${b}`)].join("\n");
}


function subagentNotesSection(): string {
  return [
    "# Operating as a subagent",
    "- You cannot ask the user questions — work entirely from the prompt you were given.",
    "- You do not see the parent conversation; the caller only sees your final message.",
    "- Make your final message a concise, self-contained report: what you did and the key findings. Use absolute file paths.",
  ].join("\n");
}

function projectInstructions(cwd: string): string | null {
  for (const name of ["CAGENT.md", "AGENTS.md"]) {
    const p = resolve(cwd, name);
    if (!existsSync(p)) continue;
    try {
      const content = readFileSync(p, "utf8").trim();
      if (content) return `<project-instructions file="${name}">\n${content}\n</project-instructions>`;
    } catch {
      /* ignore unreadable project file */
    }
    return null;
  }
  return null;
}

/**
 * Build the full system prompt. Static sections come first (cacheable prefix);
 * the volatile git-status / MCP-instruction block is appended last so the
 * static prefix stays byte-stable across turns.
 */
export async function buildSystemPrompt(opts: SystemPromptOptions): Promise<string> {
  const gitInfo = opts.subagent
    ? { isGit: existsSync(resolve(opts.cwd, ".git")), isWorktree: false, status: null }
    : await probeGit(opts.pm, opts.cwd);

  const sections: (string | null)[] = [
    // --- static instruction prefix ---
    opts.base,
    opts.behavior,
    opts.subagent ? subagentNotesSection() : null,
    toolsSection(opts.toolNames),
    skillsSection(opts.skills),
    environmentSection(opts, gitInfo),
    projectInstructions(opts.cwd),
    opts.mcpInstructions ? `# MCP server instructions\n\n${opts.mcpInstructions}` : null,
    // --- volatile session context (kept last) ---
    gitInfo.status,
  ];

  return sections
    .filter((s): s is string => typeof s === "string" && s.trim().length > 0)
    .join("\n\n");
}

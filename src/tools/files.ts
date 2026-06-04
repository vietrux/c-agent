import { readFile, writeFile, mkdir, glob } from "node:fs/promises";
import { dirname, resolve, isAbsolute, basename } from "node:path";
import type { Tool } from "./registry.js";

// Dirs that are never search targets and blow up a recursive walk. Pruned
// during glob traversal (descent stops), so `glob` from a deep/home dir can't
// hang on node_modules/.git/caches.
const GLOB_PRUNE = new Set([
  "node_modules",
  ".git",
  ".svn",
  ".hg",
  ".cache",
  ".npm",
  ".pnpm-store",
  ".yarn",
  ".cargo",
  ".rustup",
  ".gradle",
  ".m2",
  ".nuget",
  "__pycache__",
  ".mypy_cache",
  ".pytest_cache",
  ".venv",
  "venv",
]);
const GLOB_DEADLINE_MS = 10_000; // wall-clock budget; enforced via the prune hook

function abs(cwd: string, p: string): string {
  return isAbsolute(p) ? p : resolve(cwd, p);
}

export const readTool: Tool = {
  concurrencySafe: true,
  spec: {
    name: "read",
    description:
      "Reads a file from the local filesystem. The path may be absolute or relative to the " +
      "working directory. Returns content in cat -n format with 1-based line numbers. By default " +
      "reads up to 2000 lines from the start; use offset and limit for large files. You should " +
      "read a file before editing or overwriting it. Prefer reading the specific range you need " +
      "over the whole file when the file is large.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string" },
        offset: { type: "number", description: "1-based start line" },
        limit: { type: "number", description: "max lines (default 2000)" },
      },
      required: ["path"],
    },
  },
  async run(input, ctx) {
    const full = abs(ctx.cwd, input.path);
    const raw = await readFile(full, "utf8");
    const lines = raw.split("\n");
    const start = Math.max(0, (input.offset ?? 1) - 1);
    const limit = input.limit ?? 2000;
    const slice = lines.slice(start, start + limit);
    const numbered = slice.map((l, i) => `${start + i + 1}\t${l}`).join("\n");
    return { text: numbered || "(empty file)" };
  },
};

export const writeTool: Tool = {
  risky: true,
  spec: {
    name: "write",
    description:
      "Writes a file to the local filesystem, overwriting it if it already exists, and creating " +
      "parent directories as needed. You MUST read an existing file before overwriting it. " +
      "ALWAYS prefer edit for small changes to existing files — only use write for new files or " +
      "full rewrites. NEVER create documentation files (*.md) or README files unless explicitly " +
      "requested. Only add emojis if the user asks.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string" },
        content: { type: "string" },
      },
      required: ["path", "content"],
    },
  },
  async run(input, ctx) {
    const full = abs(ctx.cwd, input.path);
    ctx.checkpointer?.snapshot(full);
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, input.content, "utf8");
    const bytes = Buffer.byteLength(input.content, "utf8");
    return { text: `wrote ${bytes} bytes to ${full}` };
  },
};

export const editTool: Tool = {
  risky: true,
  spec: {
    name: "edit",
    description:
      "Performs exact string replacements in a file. You must read the file before editing it. " +
      "When editing from read output, preserve the exact indentation (tabs/spaces) as it appears " +
      "AFTER the line-number prefix — never include any part of that prefix. The edit FAILS if " +
      "old_string is not found, or if it matches more than once and replace_all is not set; in " +
      "that case provide a larger, more specific old_string with surrounding context to make it " +
      "unique. Prefer edit over write for changes to existing files.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string" },
        old_string: { type: "string", description: "Exact text to replace" },
        new_string: { type: "string", description: "Replacement text" },
        replace_all: { type: "boolean", description: "Replace every occurrence" },
      },
      required: ["path", "old_string", "new_string"],
    },
  },
  async run(input, ctx) {
    const full = abs(ctx.cwd, input.path);
    const { old_string, new_string, replace_all } = input;
    if (old_string === new_string) {
      return { text: "old_string and new_string are identical", isError: true };
    }
    const raw = await readFile(full, "utf8");
    const count = raw.split(old_string).length - 1;
    if (count === 0) return { text: `old_string not found in ${full}`, isError: true };
    if (count > 1 && !replace_all) {
      return {
        text: `old_string matches ${count} times; add more context or set replace_all`,
        isError: true,
      };
    }
    const updated = replace_all
      ? raw.split(old_string).join(new_string)
      : raw.replace(old_string, new_string);
    ctx.checkpointer?.snapshot(full);
    await writeFile(full, updated, "utf8");
    return { text: `edited ${full} (${replace_all ? count : 1} replacement${count > 1 && replace_all ? "s" : ""})` };
  },
};

export const multiEditTool: Tool = {
  risky: true,
  spec: {
    name: "multi_edit",
    description:
      "Apply several exact string replacements to ONE file in a single atomic operation. Edits " +
      "run sequentially in array order — each operates on the result of the previous one. If any " +
      "edit fails (old_string not found, or matches >1 without replace_all), NOTHING is written. " +
      "Read the file first. Prefer this over many edit calls when changing one file in several " +
      "places. Each edit's old_string must be unique unless replace_all is set.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string" },
        edits: {
          type: "array",
          description: "Replacements applied in order",
          items: {
            type: "object",
            properties: {
              old_string: { type: "string" },
              new_string: { type: "string" },
              replace_all: { type: "boolean" },
            },
            required: ["old_string", "new_string"],
          },
        },
      },
      required: ["path", "edits"],
    },
  },
  async run(input, ctx) {
    const full = abs(ctx.cwd, input.path);
    const edits = input.edits;
    if (!Array.isArray(edits) || edits.length === 0) {
      return { text: "edits must be a non-empty array", isError: true };
    }
    let content = await readFile(full, "utf8");
    for (let i = 0; i < edits.length; i++) {
      const { old_string, new_string, replace_all } = edits[i];
      if (old_string === new_string) {
        return { text: `edit ${i + 1}: old_string and new_string are identical`, isError: true };
      }
      const count = content.split(old_string).length - 1;
      if (count === 0) return { text: `edit ${i + 1}: old_string not found`, isError: true };
      if (count > 1 && !replace_all) {
        return { text: `edit ${i + 1}: matches ${count} times; add context or set replace_all`, isError: true };
      }
      content = replace_all
        ? content.split(old_string).join(new_string)
        : content.replace(old_string, new_string);
    }
    ctx.checkpointer?.snapshot(full);
    await writeFile(full, content, "utf8");
    return { text: `applied ${edits.length} edits to ${full}` };
  },
};

export const globTool: Tool = {
  concurrencySafe: true,
  spec: {
    name: "glob",
    description:
      "Fast file-pattern matching that works in any codebase. Supports glob patterns like " +
      "'**/*.ts' or 'src/**/*.test.js' and returns matching paths relative to the search dir. " +
      "Use this instead of bash find/ls when looking for files by name or extension. When you " +
      "are doing an open-ended search that may need multiple rounds, prefer grep for content.",
    parameters: {
      type: "object",
      properties: {
        pattern: { type: "string" },
        path: { type: "string", description: "base dir (default cwd)" },
      },
      required: ["pattern"],
    },
  },
  async run(input, ctx, signal) {
    const base = input.path ? abs(ctx.cwd, input.path) : ctx.cwd;
    const matches: string[] = [];
    const LIMIT = 1000;
    const deadline = Date.now() + GLOB_DEADLINE_MS;
    let stopped: string | null = null;

    // `exclude` is the traversal-control hook: returning true prunes a path
    // (and stops descending into a directory). We use it both to skip heavy
    // dirs and to hard-stop the walk on timeout/abort — once `stopped` is set,
    // every remaining path is pruned so the walk unwinds instead of hanging.
    const exclude = (p: any): boolean => {
      if (stopped) return true;
      if (signal?.aborted) {
        stopped = "interrupted";
        return true;
      }
      if (Date.now() > deadline) {
        stopped = "timed out after 10s";
        return true;
      }
      const name = basename(typeof p === "string" ? p : p?.name ?? "");
      return GLOB_PRUNE.has(name);
    };

    try {
      const it = glob(input.pattern, { cwd: base, exclude }) as AsyncIterable<string>;
      for await (const entry of it) {
        matches.push(entry);
        if (matches.length >= LIMIT) {
          stopped = `capped at ${LIMIT}`;
          break;
        }
      }
    } catch (err: any) {
      if (err?.name !== "AbortError")
        return { text: `glob failed: ${err?.message ?? String(err)}`, isError: true };
    }

    if (matches.length === 0)
      return { text: stopped ? `no matches (${stopped})` : "no matches" };
    matches.sort();
    const body = matches.join("\n");
    return { text: stopped ? `${body}\n… (${stopped})` : body };
  },
};

let rgAvailable: boolean | undefined;

async function hasRg(ctx: { pm: { run: (o: any) => Promise<{ exitCode: number | null }> } }): Promise<boolean> {
  if (rgAvailable === undefined) {
    const r = await ctx.pm.run({ command: "command -v rg", timeoutMs: 5_000 });
    rgAvailable = r.exitCode === 0;
  }
  return rgAvailable;
}

const q = (s: string) => JSON.stringify(s);

export const grepTool: Tool = {
  concurrencySafe: true,
  spec: {
    name: "grep",
    description:
      "Search file contents by regex. Uses ripgrep (rg) when available, else grep. " +
      "Returns file:line:match. Honors .gitignore under rg.",
    parameters: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "regex" },
        path: { type: "string", description: "dir or file (default cwd)" },
        glob: { type: "string", description: "filter files, e.g. '*.ts' (rg -g / grep --include)" },
        ignore_case: { type: "boolean" },
        context: { type: "number", description: "lines of context around each match" },
        max_count: { type: "number", description: "cap total matching lines (default 200)" },
      },
      required: ["pattern"],
    },
  },
  async run(input, ctx) {
    const target = input.path ? abs(ctx.cwd, input.path) : ctx.cwd;
    const ctxLines = Number.isFinite(input.context) ? Math.max(0, Math.floor(input.context)) : 0;
    const cap = Number.isFinite(input.max_count) ? Math.max(1, Math.floor(input.max_count)) : 200;

    let cmd: string;
    if (await hasRg(ctx)) {
      const parts = ["rg", "--line-number", "--no-heading", "--color=never"];
      if (input.ignore_case) parts.push("--ignore-case");
      if (input.glob) parts.push("-g", q(input.glob));
      if (ctxLines) parts.push("-C", String(ctxLines));
      parts.push("--", q(input.pattern), q(target));
      cmd = parts.join(" ");
    } else {
      const parts = ["grep", "-rnI", "--color=never"];
      if (input.ignore_case) parts.push("-i");
      if (input.glob) parts.push(`--include=${q(input.glob)}`);
      if (ctxLines) parts.push("-C", String(ctxLines));
      parts.push("--", q(input.pattern), q(target));
      cmd = parts.join(" ");
    }

    const r = await ctx.pm.run({ command: cmd, cwd: ctx.cwd, timeoutMs: 30_000 });
    const lines = r.output.split("\n").filter((l) => l.length > 0);
    if (lines.length === 0) return { text: "no matches" };
    const shown = lines.slice(0, cap);
    const body = shown.join("\n");
    return { text: lines.length > cap ? body + `\n… (${lines.length - cap} more, raise max_count)` : body };
  },
};

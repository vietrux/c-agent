import { homedir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { writeSecureFile } from "./utils/secure-fs.js";

// Bash-style input history: every submitted line is appended, recalled with
// up/down in the editor, and persisted across launches. Stored newline-
// delimited (oldest→newest) under ~/.c-agent/history.
const DIR = join(homedir(), ".c-agent");
const FILE = join(DIR, "history");
const MAX = 500;

let cache: string[] | null = null;

/** Past submissions, oldest→newest, capped at MAX. */
export function loadHistory(): string[] {
  if (cache) return cache;
  try {
    cache = readFileSync(FILE, "utf8")
      .split("\n")
      .filter((l) => l.length > 0)
      .slice(-MAX);
  } catch {
    cache = [];
  }
  return cache;
}

/** Append one submission, dedup consecutive duplicates, persist. */
export function pushHistory(line: string): void {
  const t = line.trim().replace(/\r?\n/g, " ");
  if (!t) return;
  const h = loadHistory();
  if (h[h.length - 1] === t) return; // skip immediate repeat (like bash ignoredups)
  h.push(t);
  if (h.length > MAX) h.splice(0, h.length - MAX);
  try {
    writeSecureFile(FILE, h.join("\n") + "\n");
  } catch {
    /* history is best-effort; ignore write failures */
  }
}

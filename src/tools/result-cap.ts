import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  mkdirSync,
  writeFileSync,
  readdirSync,
  statSync,
  rmSync,
} from "node:fs";

/** Default cap on tool-result chars fed to the model before spill-to-disk. */
export const DEFAULT_MAX_TOOL_RESULT = 64_000;

const RESULTS_DIR = join(homedir(), ".c-agent", "tool-results");
const PRUNE_AGE_MS = 24 * 60 * 60 * 1000; // delete spilled files older than a day
let prunedThisProcess = false;

/** Best-effort one-time cleanup so the spill dir can't grow without bound. */
function pruneOnce(): void {
  if (prunedThisProcess) return;
  prunedThisProcess = true;
  try {
    const now = Date.now();
    for (const name of readdirSync(RESULTS_DIR)) {
      const p = join(RESULTS_DIR, name);
      try {
        if (now - statSync(p).mtimeMs > PRUNE_AGE_MS) rmSync(p);
      } catch {
        /* ignore individual file errors */
      }
    }
  } catch {
    /* dir may not exist yet — nothing to prune */
  }
}

/** Head+tail truncation — used only when spilling to disk fails. */
function headTail(text: string, max: number): string {
  const head = text.slice(0, Math.floor(max * 0.6));
  const tail = text.slice(-Math.floor(max * 0.3));
  return `${head}\n… [${text.length - head.length - tail.length} chars truncated] …\n${tail}`;
}

/**
 * Cap a tool result for the model. Within `max` → returned unchanged. Over `max`
 * → the full output is persisted to disk and the model gets a head preview plus
 * the file path (so it can `read` more), mirroring Claude Code's behavior — no
 * silent loss of the middle. `max === Infinity` disables capping entirely (used
 * by the read tool to avoid a read→file→read loop).
 *
 * If the disk write fails, falls back to head+tail truncation so a result is
 * always returned (never throws, never drops everything).
 */
export function capToolResult(text: string, max: number = DEFAULT_MAX_TOOL_RESULT): string {
  if (!Number.isFinite(max) || text.length <= max) return text;

  try {
    pruneOnce();
    mkdirSync(RESULTS_DIR, { recursive: true, mode: 0o700 });
    const path = join(RESULTS_DIR, `${Date.now().toString(36)}-${randomUUID().slice(0, 8)}.txt`);
    writeFileSync(path, text, { mode: 0o600 });
    const preview = text.slice(0, max);
    return (
      `${preview}\n\n[output truncated — ${text.length} chars total. ` +
      `Full output saved to ${path}. Use the read tool (with offset/limit) to view more.]`
    );
  } catch {
    return headTail(text, max);
  }
}

export interface ToolResultLike {
  id: string;
  content: string;
  isError: boolean;
}

/**
 * Cap the aggregate tool-result payload for a single assistant turn. This guards
 * the next model request from death-by-many-results: each tool may be under its
 * own cap, but twenty reads/greps can still overwhelm context and latency.
 */
export function capToolResultsAggregate<T extends ToolResultLike>(
  results: T[],
  budget: number,
): T[] {
  if (!Number.isFinite(budget) || budget <= 0) return results;
  const total = results.reduce((sum, result) => sum + result.content.length, 0);
  if (total <= budget) return results;

  let used = 0;
  return results.map((result, index) => {
    const remainingResults = results.length - index;
    const remainingBudget = budget - used;
    const minPreview = Math.min(2_000, Math.max(200, Math.floor(budget * 0.05)));
    const share = Math.max(
      minPreview,
      Math.floor(Math.max(0, remainingBudget) / remainingResults),
    );

    if (remainingBudget <= 0) {
      const omitted =
        `[tool output omitted due to aggregate result budget — ${result.content.length} chars. ` +
        `Ask to rerun or narrow the query if this specific output is needed.]`;
      return { ...result, content: omitted };
    }

    if (used + result.content.length <= budget) {
      used += result.content.length;
      return result;
    }

    const capped = capToolResult(result.content, Math.min(share, remainingBudget));
    used += capped.length;
    return { ...result, content: capped };
  });
}

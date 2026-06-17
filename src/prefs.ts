import { homedir } from "node:os";
import { join } from "node:path";
import { readFileSync, existsSync } from "node:fs";
import { writeSecureFile } from "./utils/secure-fs.js";

const FILE = join(homedir(), ".c-agent", "state.json");

export interface Prefs {
  /** Provider name + model id last chosen in /model, restored on next launch. */
  lastProvider?: string;
  lastModel?: string;
  /** Whether the TUI starts in full-screen (alternate screen) mode. */
  fullscreen?: boolean;
}

export function loadPrefs(): Prefs {
  if (!existsSync(FILE)) return {};
  try {
    return JSON.parse(readFileSync(FILE, "utf8")) as Prefs;
  } catch {
    return {};
  }
}

/** Merge a partial update into the stored prefs so callers don't clobber each
 * other's fields (e.g. /model writing provider/model must not drop fullscreen). */
export function savePrefs(p: Partial<Prefs>): void {
  try {
    writeSecureFile(FILE, JSON.stringify({ ...loadPrefs(), ...p }));
  } catch {
    /* best effort */
  }
}

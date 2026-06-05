import { homedir } from "node:os";
import { join } from "node:path";
import { readFileSync, existsSync } from "node:fs";
import { writeSecureFile } from "./utils/secure-fs.js";

const FILE = join(homedir(), ".c-agent", "state.json");

export interface Prefs {
  /** Provider name + model id last chosen in /model, restored on next launch. */
  lastProvider?: string;
  lastModel?: string;
}

export function loadPrefs(): Prefs {
  if (!existsSync(FILE)) return {};
  try {
    return JSON.parse(readFileSync(FILE, "utf8")) as Prefs;
  } catch {
    return {};
  }
}

export function savePrefs(p: Prefs): void {
  try {
    writeSecureFile(FILE, JSON.stringify(p));
  } catch {
    /* best effort */
  }
}

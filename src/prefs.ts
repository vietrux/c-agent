import { homedir } from "node:os";
import { join } from "node:path";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";

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
    mkdirSync(join(homedir(), ".c-agent"), { recursive: true });
    writeFileSync(FILE, JSON.stringify(p), "utf8");
  } catch {
    /* best effort */
  }
}

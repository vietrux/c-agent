import { homedir } from "node:os";
import { join } from "node:path";
import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { parseFrontmatter } from "./utils/frontmatter.js";

export interface Skill {
  name: string;
  description: string;
  body: string; // full SKILL.md instructions (progressive disclosure payload)
}

function skillDirs(cwd: string): string[] {
  return [join(homedir(), ".c-agent", "skills"), join(cwd, ".c-agent", "skills")];
}

/**
 * Discover skills from ~/.c-agent/skills/<name>/SKILL.md and <cwd>/.c-agent/skills/...
 * Project skills override same-named user skills.
 */
export function loadSkills(cwd: string): Skill[] {
  const byName = new Map<string, Skill>();
  for (const dir of skillDirs(cwd)) {
    if (!existsSync(dir)) continue;
    for (const entry of readdirSync(dir)) {
      const skillFile = join(dir, entry, "SKILL.md");
      if (!existsSync(skillFile) || !statSync(skillFile).isFile()) continue;
      try {
        const { meta, body } = parseFrontmatter(readFileSync(skillFile, "utf8"));
        const name = meta.name || entry;
        byName.set(name, { name, description: meta.description || "", body });
      } catch {
        /* skip unreadable skill */
      }
    }
  }
  return [...byName.values()];
}

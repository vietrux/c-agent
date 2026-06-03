import { homedir } from "node:os";
import { join } from "node:path";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { parseFrontmatter } from "./utils/frontmatter.js";

export interface AgentDef {
  name: string;
  description: string;
  tools: string[] | null; // null = all tools; else allowlist of tool names
  systemPrompt: string;
}

function agentDirs(cwd: string): string[] {
  return [join(homedir(), ".c-agent", "agents"), join(cwd, ".c-agent", "agents")];
}

/** Discover subagent definitions from ~/.c-agent/agents/*.md and <cwd>/.c-agent/agents/*.md */
export function loadAgentDefs(cwd: string): Map<string, AgentDef> {
  const out = new Map<string, AgentDef>();
  for (const dir of agentDirs(cwd)) {
    if (!existsSync(dir)) continue;
    for (const file of readdirSync(dir)) {
      if (!file.endsWith(".md")) continue;
      try {
        const { meta, body } = parseFrontmatter(readFileSync(join(dir, file), "utf8"));
        const name = meta.name || file.replace(/\.md$/, "");
        const tools = meta.tools ? meta.tools.split(",").map((s) => s.trim()).filter(Boolean) : null;
        out.set(name, { name, description: meta.description || "", tools, systemPrompt: body });
      } catch {
        /* skip */
      }
    }
  }
  return out;
}

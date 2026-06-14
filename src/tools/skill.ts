import type { Tool } from "./registry.js";

function formatAvailable(skills: { name: string }[]): string {
  return skills.map((s) => s.name).join(", ") || "(none)";
}

function normalizeSkillNames(input: any): { names: string[]; invalid: string[] } {
  const raw: unknown[] = [];
  const invalid: string[] = [];

  if (input?.name !== undefined) {
    if (typeof input.name === "string") raw.push(input.name);
    else invalid.push("name");
  }

  if (input?.names !== undefined) {
    if (Array.isArray(input.names)) raw.push(...input.names);
    else invalid.push("names");
  }

  const names: string[] = [];
  const seen = new Set<string>();
  for (const value of raw) {
    if (typeof value !== "string") {
      invalid.push("names[]");
      continue;
    }
    const name = value.trim().replace(/^\/+/, "");
    if (!name || seen.has(name)) continue;
    seen.add(name);
    names.push(name);
  }

  return { names, invalid };
}

export const skillTool: Tool = {
  concurrencySafe: true,
  // Not deferred: the system prompt's <skills> block tells the model to call this
  // tool directly, so it must be in the schema whenever skills exist (it's only
  // registered then). Hiding it behind tool_search created an undocumented
  // activate-first dance that weaker models loop on instead of completing.
  spec: {
    name: "skill",
    description:
      "Load full instructions for one or more skills. Skills are reusable procedures with extra " +
      "context and steps. Available skills are listed in the system prompt under <skills>. Call " +
      "this BEFORE attempting a task covered by any skill. For tasks covered by multiple skills, " +
      "pass all relevant names in `names` so their instructions can be composed together.",
    parameters: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: "Single skill name to load. Kept for backward compatibility.",
        },
        names: {
          type: "array",
          items: { type: "string" },
          description: "Multiple skill names to load and compose in one call.",
        },
      },
      required: [],
    },
  },
  async run(input, ctx) {
    const skills = ctx.skills ?? [];
    const requested = normalizeSkillNames(input);
    if (requested.invalid.length > 0) {
      return {
        text:
          `invalid skill request: ${requested.invalid.join(", ")} must be string skill name(s)`,
        isError: true,
      };
    }
    if (requested.names.length === 0) {
      return {
        text: `missing skill name. pass \`name\` or \`names\`. available: ${formatAvailable(skills)}`,
        isError: true,
      };
    }

    const byName = new Map(skills.map((s) => [s.name, s]));
    const missing = requested.names.filter((name) => !byName.has(name));
    if (missing.length > 0) {
      return {
        text:
          `unknown skill${missing.length === 1 ? "" : "s"}: ${missing.join(", ")}. ` +
          `available: ${formatAvailable(skills)}`,
        isError: true,
      };
    }

    const loaded = requested.names.map((name) => byName.get(name)!);
    if (loaded.length === 1) {
      const skill = loaded[0];
      return { text: `# Skill: ${skill.name}\n\n${skill.body}` };
    }

    const body = loaded
      .map((skill) => `<skill name="${skill.name}">\n${skill.body}\n</skill>`)
      .join("\n\n");
    return {
      text:
        `# Skills loaded: ${loaded.map((s) => s.name).join(", ")}\n\n` +
        "Use these skill instructions compositionally. Apply all relevant guidance; " +
        "if two loaded skills conflict, prefer the instruction that is most specific to the current subtask.\n\n" +
        body,
    };
  },
};

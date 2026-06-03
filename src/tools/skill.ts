import type { Tool } from "./registry.js";

export const skillTool: Tool = {
  spec: {
    name: "skill",
    description:
      "Load a skill's full instructions by name. Skills are reusable procedures with extra " +
      "context and steps. Available skills are listed in the system prompt under <skills>. Call " +
      "this BEFORE attempting a task a skill covers; the returned instructions then guide your work.",
    parameters: {
      type: "object",
      properties: { name: { type: "string", description: "Skill name to load" } },
      required: ["name"],
    },
  },
  async run(input, ctx) {
    const skills = ctx.skills ?? [];
    const skill = skills.find((s) => s.name === input.name);
    if (!skill) {
      const names = skills.map((s) => s.name).join(", ") || "(none)";
      return { text: `unknown skill: ${input.name}. available: ${names}`, isError: true };
    }
    return { text: `# Skill: ${skill.name}\n\n${skill.body}` };
  },
};

import type { Tool } from "./registry.js";

export const taskTool: Tool = {
  spec: {
    name: "task",
    description:
      "Delegate a self-contained task to a subagent that runs with its own fresh context and the " +
      "same tools, then returns only its final summary. Use for multi-step research or work that " +
      "would bloat this context (e.g. 'find everywhere X is used', 'investigate this bug'). The " +
      "subagent cannot ask you questions — write a complete, standalone prompt with all needed " +
      "detail. It does not see this conversation. Optionally pick an agent type defined in " +
      ".c-agent/agents (default: general-purpose). Set background:true to run it detached and " +
      "keep working — you are notified with its result when it finishes (use for long jobs you " +
      "can parallelize; the call returns an id immediately instead of the summary).",
    parameters: {
      type: "object",
      properties: {
        description: { type: "string", description: "Short (3-5 word) task label" },
        prompt: { type: "string", description: "Full self-contained task for the subagent" },
        subagent_type: { type: "string", description: "Agent type name (default general-purpose)" },
        background: {
          type: "boolean",
          description: "Run detached; return an id now and notify on completion (default false)",
        },
      },
      required: ["prompt"],
    },
  },
  async run(input, ctx) {
    if (input.background) {
      if (!ctx.spawnBackground)
        return { text: "(background subagents unavailable in this context)", isError: true };
      const id = ctx.spawnBackground(input.prompt, input.subagent_type);
      return {
        text: `Started background subagent [${id}] (${input.subagent_type || "general-purpose"}). You'll be notified with its result when it finishes.`,
      };
    }
    if (!ctx.spawn) return { text: "(subagents unavailable in this context)", isError: true };
    const text = await ctx.spawn(input.prompt, input.subagent_type);
    return { text: text || "(subagent returned nothing)" };
  },
};

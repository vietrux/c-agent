import type { Tool, TodoItem } from "./registry.js";

export const todoTool: Tool = {
  spec: {
    name: "todo",
    description:
      "Create and manage a structured task list for the current session. action=write replaces " +
      "the whole list; action=read returns it. Use this to plan and track tasks with 3+ steps so " +
      "the user can see progress. Mark exactly one item as in_progress before you start it, and " +
      "mark it done IMMEDIATELY after finishing — do not batch completions. Keep only one task " +
      "in_progress at a time. Skip this tool for trivial single-step tasks.",
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["read", "write"] },
        items: {
          type: "array",
          description: "Full list when action=write",
          items: {
            type: "object",
            properties: {
              text: { type: "string" },
              status: { type: "string", enum: ["pending", "in_progress", "done"] },
            },
            required: ["text", "status"],
          },
        },
      },
      required: ["action"],
    },
  },
  async run(input, ctx) {
    if (input.action === "write" && Array.isArray(input.items)) {
      ctx.todos.length = 0;
      for (const it of input.items as TodoItem[]) ctx.todos.push(it);
    }
    if (ctx.todos.length === 0) return { text: "(no todos)" };
    const mark = { pending: "[ ]", in_progress: "[~]", done: "[x]" } as const;
    return { text: ctx.todos.map((t) => `${mark[t.status]} ${t.text}`).join("\n") };
  },
};

export const askTool: Tool = {
  spec: {
    name: "ask_user",
    description:
      "Ask the user a clarifying question and wait for their typed answer. " +
      "Use only when genuinely blocked on a decision you cannot make.",
    parameters: {
      type: "object",
      properties: { question: { type: "string" } },
      required: ["question"],
    },
  },
  async run(input, ctx) {
    if (!ctx.ask) return { text: "(ask unavailable in this context)", isError: true };
    const answer = await ctx.ask(input.question);
    return { text: answer || "(no answer)" };
  },
};

import type { Tool, ToolContext, ToolRegistry } from "./registry.js";

function renderTool(tool: Tool, active: boolean): string {
  const state = active ? "active" : "deferred";
  return `- ${tool.spec.name} [${state}]: ${tool.spec.description}`;
}

export function createToolSearchTool(registry: ToolRegistry): Tool {
  return {
    concurrencySafe: true,
    maxResultChars: Infinity,
    spec: {
      name: "tool_search",
      description:
        "Search and activate deferred specialty tools that are not currently in the model tool schema. " +
        "Use this when you need a capability that is not available as a direct tool, such as web_fetch, " +
        "encode_decode, notes, or skills. To activate one exact tool, call with query `select:<tool_name>`.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description:
              "Keyword search, or select:<tool_name> to activate one deferred tool",
          },
        },
        required: ["query"],
      },
    },
    async run(input, _ctx: ToolContext) {
      const query = String(input.query ?? "").trim();
      if (!query) {
        const tools = registry.searchDeferred("", 12);
        if (tools.length === 0) return { text: "no deferred tools available" };
        return {
          text:
            "Deferred tools:\n" +
            tools.map((t) => renderTool(t, registry.isActive(t.spec.name))).join("\n") +
            "\n\nActivate one with query `select:<tool_name>`.",
        };
      }

      const select = query.match(/^select:([A-Za-z_][\w]*)$/);
      if (select) {
        const name = select[1];
        const tool = registry.deferredTools().find((t) => t.spec.name === name);
        if (!tool) return { text: `no deferred tool named ${name}`, isError: true };
        registry.activate(name);
        return {
          text:
            `activated ${name}. The tool schema will be available on the next model turn.\n\n` +
            renderTool(tool, true),
        };
      }

      const matches = registry.searchDeferred(query, 8);
      if (matches.length === 0) {
        return {
          text:
            `no deferred tools matched "${query}". Try a broader keyword or call with an empty query to list all deferred tools.`,
        };
      }
      return {
        text:
          `Deferred tool matches for "${query}":\n` +
          matches.map((t) => renderTool(t, registry.isActive(t.spec.name))).join("\n") +
          "\n\nActivate one with query `select:<tool_name>`.",
      };
    },
  };
}

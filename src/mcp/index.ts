import { McpClient, type McpResource, type McpPrompt } from "./client.js";
import type { McpServerConfig } from "../settings.js";
import type { Tool, ToolRegistry } from "../tools/registry.js";

export interface ServerStatus {
  name: string;
  ok: boolean;
  tools: number;
  resources: McpResource[];
  prompts: McpPrompt[];
  error?: string;
}

export interface McpConnectResult {
  clients: McpClient[];
  registered: number;
  servers: ServerStatus[];
  summary: string;
}

/** Sanitize server/tool names into the `mcp__<server>__<tool>` namespace. */
function ns(server: string, tool: string): string {
  const clean = (s: string) => s.replace(/[^A-Za-z0-9_]/g, "_");
  return `mcp__${clean(server)}__${clean(tool)}`;
}

/**
 * Connect every configured MCP server, discover its tools/resources/prompts, and
 * register the tools into the registry under the `mcp__server__tool` namespace.
 * MCP tools are risky (opaque side effects) so they go through approval. If any
 * server exposes resources, a single `read_mcp_resource` tool is registered too.
 */
export async function connectMcpServers(
  registry: ToolRegistry,
  servers: Record<string, McpServerConfig>,
): Promise<McpConnectResult> {
  const clients: McpClient[] = [];
  const statuses: ServerStatus[] = [];
  const byName = new Map<string, McpClient>();
  let registered = 0;

  await Promise.all(
    Object.entries(servers).map(async ([name, cfg]) => {
      const client = new McpClient(name, cfg);
      try {
        await client.connect();
        const [tools, resources, prompts] = await Promise.all([
          client.listTools(),
          client.listResources(),
          client.listPrompts(),
        ]);
        for (const t of tools) {
          const tool: Tool = {
            risky: true,
            spec: {
              name: ns(name, t.name),
              description: `[mcp:${name}] ${t.description ?? t.name}`,
              parameters: normalizeSchema(t.inputSchema),
            },
            run: (input) => client.callTool(t.name, input),
          };
          registry.register(tool);
          registered++;
        }
        clients.push(client);
        byName.set(name, client);
        statuses.push({ name, ok: true, tools: tools.length, resources, prompts });
      } catch (err: any) {
        client.close();
        statuses.push({ name, ok: false, tools: 0, resources: [], prompts: [], error: err?.message ?? String(err) });
      }
    }),
  );

  const hasResources = statuses.some((s) => s.resources.length > 0);
  if (hasResources) registry.register(makeResourceTool(byName));

  return {
    clients,
    registered,
    servers: statuses,
    summary: renderSummary(statuses, registered),
  };
}

/** Tools must advertise an object JSON schema; coerce missing/invalid ones. */
function normalizeSchema(schema: any): Record<string, any> {
  if (schema && typeof schema === "object" && schema.type === "object") return schema;
  return { type: "object", properties: {} };
}

function makeResourceTool(byName: Map<string, McpClient>): Tool {
  return {
    spec: {
      name: "read_mcp_resource",
      description:
        "Read the contents of an MCP resource exposed by a connected server. Use the server name " +
        "and the resource uri shown by the /mcp command.",
      parameters: {
        type: "object",
        properties: {
          server: { type: "string", description: "MCP server name" },
          uri: { type: "string", description: "Resource uri" },
        },
        required: ["server", "uri"],
      },
    },
    async run(input) {
      const client = byName.get(input.server);
      if (!client) return { text: `unknown MCP server: ${input.server}`, isError: true };
      try {
        return { text: (await client.readResource(input.uri)) || "(empty resource)" };
      } catch (err: any) {
        return { text: `resource read failed: ${err?.message ?? String(err)}`, isError: true };
      }
    },
  };
}

function renderSummary(statuses: ServerStatus[], registered: number): string {
  if (statuses.length === 0) return "no MCP servers configured";
  const ok = statuses.filter((s) => s.ok).length;
  const lines = [`MCP: ${ok}/${statuses.length} servers connected · ${registered} tools`];
  for (const s of statuses) {
    if (!s.ok) {
      lines.push(`  ✗ ${s.name}: ${s.error}`);
      continue;
    }
    const bits = [`${s.tools} tools`];
    if (s.resources.length) bits.push(`${s.resources.length} resources`);
    if (s.prompts.length) bits.push(`${s.prompts.length} prompts`);
    lines.push(`  ✓ ${s.name}: ${bits.join(", ")}`);
    for (const r of s.resources.slice(0, 5)) lines.push(`      · ${r.uri}${r.name ? ` (${r.name})` : ""}`);
  }
  return lines.join("\n");
}

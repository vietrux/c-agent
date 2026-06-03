import type { McpServerConfig } from "../settings.js";
import { makeTransport, type Transport, type Frame } from "./transport.js";

const PROTOCOL_VERSION = "2024-11-05";

export interface McpTool {
  name: string;
  description?: string;
  inputSchema?: Record<string, any>;
}
export interface McpResource {
  uri: string;
  name?: string;
  description?: string;
  mimeType?: string;
}
export interface McpPrompt {
  name: string;
  description?: string;
}

export interface ToolCallResult {
  text: string;
  isError: boolean;
}

interface Pending {
  resolve: (v: any) => void;
  reject: (e: any) => void;
  timer: NodeJS.Timeout;
}

/**
 * MCP client speaking JSON-RPC 2.0 over a pluggable transport. Handles the full
 * lifecycle: initialize handshake, capability-gated discovery (tools, resources,
 * prompts) with pagination, tool calls, inbound server requests (ping, etc.),
 * and graceful teardown.
 */
export class McpClient {
  private transport: Transport;
  private seq = 0;
  private pending = new Map<number, Pending>();
  private closed = false;
  private defaultTimeout: number;

  capabilities: Record<string, any> = {};
  serverInfo: { name?: string; version?: string } = {};

  constructor(
    readonly name: string,
    private config: McpServerConfig,
  ) {
    this.defaultTimeout = config.timeout ?? 60_000;
    this.transport = makeTransport(name, config);
    this.transport.onMessage = (f) => this.onMessage(f);
    this.transport.onClose = (err) => this.onClose(err);
  }

  /** Open the transport and run the initialize handshake. */
  async connect(): Promise<void> {
    await this.transport.open();
    const init = await this.request("initialize", {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: { roots: { listChanged: false }, sampling: {} },
      clientInfo: { name: "c-agent", version: "0.1.0" },
    });
    this.capabilities = init?.capabilities ?? {};
    this.serverInfo = init?.serverInfo ?? {};
    this.notify("notifications/initialized");
  }

  async listTools(): Promise<McpTool[]> {
    if (!this.capabilities.tools) return [];
    return this.paginate<McpTool>("tools/list", "tools");
  }

  async listResources(): Promise<McpResource[]> {
    if (!this.capabilities.resources) return [];
    try {
      return await this.paginate<McpResource>("resources/list", "resources");
    } catch {
      return [];
    }
  }

  async listPrompts(): Promise<McpPrompt[]> {
    if (!this.capabilities.prompts) return [];
    try {
      return await this.paginate<McpPrompt>("prompts/list", "prompts");
    } catch {
      return [];
    }
  }

  async callTool(name: string, args: any, timeoutMs?: number): Promise<ToolCallResult> {
    const res = await this.request("tools/call", { name, arguments: args ?? {} }, timeoutMs);
    return { text: flattenContent(res?.content), isError: res?.isError === true };
  }

  async readResource(uri: string): Promise<string> {
    const res = await this.request("resources/read", { uri });
    const parts: string[] = [];
    for (const c of res?.contents ?? []) {
      if (typeof c?.text === "string") parts.push(c.text);
      else if (typeof c?.blob === "string") parts.push(`[binary ${c.mimeType ?? ""} ${c.blob.length}b]`);
    }
    return parts.join("\n");
  }

  close(): void {
    this.closed = true;
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new Error(`mcp ${this.name} closed`));
    }
    this.pending.clear();
    this.transport.close();
  }

  // ---- protocol internals -------------------------------------------------

  private async paginate<T>(method: string, key: string): Promise<T[]> {
    const out: T[] = [];
    let cursor: string | undefined;
    do {
      const res = await this.request(method, cursor ? { cursor } : {});
      if (Array.isArray(res?.[key])) out.push(...res[key]);
      cursor = res?.nextCursor;
    } while (cursor);
    return out;
  }

  private onMessage(msg: Frame) {
    // Response to one of our requests.
    if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.error) p.reject(new Error(msg.error?.message ?? `mcp error ${msg.error?.code}`));
      else p.resolve(msg.result);
      return;
    }
    // Inbound request from the server (has id + method) — must answer so it
    // doesn't block. We implement ping; everything else is method-not-found.
    if (msg.id !== undefined && typeof msg.method === "string") {
      if (msg.method === "ping") this.respond(msg.id, {});
      else this.respondError(msg.id, -32601, `method not found: ${msg.method}`);
      return;
    }
    // Notification (no id) — nothing we need to act on for basic tool use.
  }

  private onClose(err?: Error) {
    if (this.closed) return;
    this.closed = true;
    const e = err ?? new Error(`mcp ${this.name} connection closed`);
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(e);
    }
    this.pending.clear();
  }

  private request(method: string, params: any = {}, timeoutMs?: number): Promise<any> {
    if (this.closed) return Promise.reject(new Error(`mcp ${this.name} is closed`));
    const id = ++this.seq;
    const ms = timeoutMs ?? this.defaultTimeout;
    const p = new Promise<any>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`mcp ${this.name} ${method} timed out after ${ms}ms`));
      }, ms);
      this.pending.set(id, { resolve, reject, timer });
    });
    // send may itself surface an error (http POST failure) — reject the pending.
    this.transport.send({ jsonrpc: "2.0", id, method, params }).catch((e) => {
      const pend = this.pending.get(id);
      if (pend) {
        this.pending.delete(id);
        clearTimeout(pend.timer);
        pend.reject(e);
      }
    });
    return p;
  }

  private notify(method: string, params: any = {}) {
    this.transport.send({ jsonrpc: "2.0", method, params }).catch(() => {});
  }

  private respond(id: any, result: any) {
    this.transport.send({ jsonrpc: "2.0", id, result }).catch(() => {});
  }

  private respondError(id: any, code: number, message: string) {
    this.transport.send({ jsonrpc: "2.0", id, error: { code, message } }).catch(() => {});
  }
}

/** Flatten an MCP tool-result content array into a single string. */
function flattenContent(content: any): string {
  if (!Array.isArray(content)) return content ? JSON.stringify(content) : "(no content)";
  const parts: string[] = [];
  for (const c of content) {
    switch (c?.type) {
      case "text":
        parts.push(c.text ?? "");
        break;
      case "image":
        parts.push(`[image ${c.mimeType ?? "?"} (${(c.data?.length ?? 0)} b64 chars)]`);
        break;
      case "audio":
        parts.push(`[audio ${c.mimeType ?? "?"}]`);
        break;
      case "resource": {
        const r = c.resource ?? {};
        parts.push(r.text ?? `[resource ${r.uri ?? ""} ${r.mimeType ?? ""}]`);
        break;
      }
      default:
        parts.push(JSON.stringify(c));
    }
  }
  return parts.join("\n") || "(no content)";
}

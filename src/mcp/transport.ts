import { spawn, ChildProcess } from "node:child_process";
import type { McpServerConfig } from "../settings.js";

export type Frame = Record<string, any>;

/**
 * Moves JSON-RPC frames to/from a server. The client owns id-correlation; a
 * transport only delivers parsed inbound frames via `onMessage` and reports
 * teardown via `onClose`.
 */
export interface Transport {
  onMessage: (frame: Frame) => void;
  onClose: (err?: Error) => void;
  open(): Promise<void>;
  send(frame: Frame): Promise<void>;
  close(): void;
}

export function makeTransport(name: string, cfg: McpServerConfig): Transport {
  const type = cfg.type ?? (cfg.url ? "http" : "stdio");
  if (type === "stdio") return new StdioTransport(name, cfg);
  if (type === "http") return new HttpTransport(name, cfg);
  throw new Error(`mcp ${name}: unsupported transport "${type}" (use stdio or http)`);
}

/** Persistent child process; newline-delimited JSON-RPC over stdio. */
class StdioTransport implements Transport {
  onMessage: (f: Frame) => void = () => {};
  onClose: (err?: Error) => void = () => {};
  private child: ChildProcess | null = null;
  private buf = "";

  constructor(
    private name: string,
    private cfg: McpServerConfig,
  ) {}

  async open(): Promise<void> {
    if (!this.cfg.command) throw new Error(`mcp ${this.name}: stdio transport needs "command"`);
    const child = spawn(this.cfg.command, this.cfg.args ?? [], {
      cwd: this.cfg.cwd,
      env: { ...process.env, ...(this.cfg.env ?? {}) },
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child = child;
    child.stdin?.on("error", () => {}); // ignore EPIPE if server dies mid-write
    child.on("error", (e) => this.onClose(e));
    child.on("exit", (code) => this.onClose(code ? new Error(`exited code ${code}`) : undefined));
    child.stdout?.on("data", (c: Buffer) => this.feed(c.toString("utf8")));
  }

  private feed(text: string) {
    this.buf += text;
    let nl: number;
    while ((nl = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, nl).trim();
      this.buf = this.buf.slice(nl + 1);
      if (!line) continue;
      try {
        this.onMessage(JSON.parse(line));
      } catch {
        /* non-JSON line (server stray output) — ignore */
      }
    }
  }

  async send(frame: Frame): Promise<void> {
    this.child?.stdin?.write(JSON.stringify(frame) + "\n");
  }

  close(): void {
    this.child?.kill("SIGTERM");
    this.child = null;
  }
}

/**
 * Streamable HTTP transport (MCP 2025 spec): each frame is POSTed; the reply is
 * either a single JSON body or a text/event-stream carrying one or more frames.
 * The session id from initialize is echoed on later requests.
 */
class HttpTransport implements Transport {
  onMessage: (f: Frame) => void = () => {};
  onClose: (err?: Error) => void = () => {};
  private sessionId?: string;

  constructor(
    private name: string,
    private cfg: McpServerConfig,
  ) {
    if (!cfg.url) throw new Error(`mcp ${name}: http transport needs "url"`);
  }

  async open(): Promise<void> {
    /* connection is per-request; nothing to set up */
  }

  async send(frame: Frame): Promise<void> {
    const headers: Record<string, string> = {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...(this.cfg.headers ?? {}),
    };
    if (this.sessionId) headers["mcp-session-id"] = this.sessionId;

    let res: Response;
    try {
      res = await fetch(this.cfg.url!, { method: "POST", headers, body: JSON.stringify(frame) });
    } catch (e: any) {
      this.onClose(e);
      throw e;
    }

    const sid = res.headers.get("mcp-session-id");
    if (sid) this.sessionId = sid;

    if (res.status === 202 || res.status === 204) return; // notification/ack, no body
    if (!res.ok) throw new Error(`mcp ${this.name}: HTTP ${res.status} ${res.statusText}`);

    const ct = res.headers.get("content-type") ?? "";
    if (ct.includes("text/event-stream")) await this.readSse(res);
    else if (ct.includes("application/json")) this.dispatch(await res.json());
    /* empty/other body → nothing to dispatch */
  }

  private dispatch(payload: any) {
    if (Array.isArray(payload)) payload.forEach((m) => this.onMessage(m));
    else if (payload && typeof payload === "object") this.onMessage(payload);
  }

  private async readSse(res: Response) {
    if (!res.body) return;
    const reader = (res.body as any).getReader();
    const decoder = new TextDecoder();
    let buf = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let sep: number;
      // events separated by blank line; data may span multiple `data:` lines
      while ((sep = buf.indexOf("\n\n")) >= 0) {
        const evt = buf.slice(0, sep);
        buf = buf.slice(sep + 2);
        const data = evt
          .split("\n")
          .filter((l) => l.startsWith("data:"))
          .map((l) => l.slice(5).trim())
          .join("\n");
        if (!data) continue;
        try {
          this.dispatch(JSON.parse(data));
        } catch {
          /* keep-alive comment or partial — ignore */
        }
      }
    }
  }

  close(): void {
    /* stateless; nothing to tear down */
  }
}

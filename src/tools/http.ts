import type { Tool } from "./registry.js";

const BODY_CAP = 32_768;

export const httpRequestTool: Tool = {
  risky: true,
  spec: {
    name: "http_request",
    description:
      "Make an HTTP/HTTPS request with full control over method, headers, body, and redirects. " +
      "Returns status line, response headers, and body (capped at 32KB). " +
      "Proxy: set HTTP_PROXY / HTTPS_PROXY env vars before launching c-agent. " +
      "SSL bypass for self-signed certs: set NODE_TLS_REJECT_UNAUTHORIZED=0.",
    parameters: {
      type: "object",
      properties: {
        url: { type: "string" },
        method: {
          type: "string",
          enum: ["GET", "POST", "PUT", "DELETE", "PATCH", "HEAD", "OPTIONS"],
          description: "default GET",
        },
        headers: { type: "object", description: "key-value header map" },
        body: { type: "string" },
        follow_redirects: { type: "boolean", description: "default true" },
        timeout_ms: { type: "number", description: "default 30000" },
      },
      required: ["url"],
    },
  },
  async run(input, _ctx) {
    const controller = new AbortController();
    const tid = setTimeout(() => controller.abort(), input.timeout_ms ?? 30_000);

    try {
      const res = await fetch(input.url as string, {
        method: (input.method as string | undefined) ?? "GET",
        headers: input.headers as Record<string, string> | undefined,
        body: input.body as string | undefined,
        redirect: input.follow_redirects === false ? "manual" : "follow",
        signal: controller.signal,
      });

      const rawBody = await res.text();
      const body =
        rawBody.length > BODY_CAP
          ? rawBody.slice(0, BODY_CAP) + `\n… [${rawBody.length - BODY_CAP} bytes truncated]`
          : rawBody;

      const headerLines: string[] = [];
      res.headers.forEach((v, k) => headerLines.push(`${k}: ${v}`));

      return {
        text: [`HTTP ${res.status} ${res.statusText}`, ...headerLines, "", body].join("\n"),
      };
    } catch (err: any) {
      return { text: `request failed: ${err?.message ?? String(err)}`, isError: true };
    } finally {
      clearTimeout(tid);
    }
  },
};

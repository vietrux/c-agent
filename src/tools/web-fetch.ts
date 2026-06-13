import type { Tool, ToolContext } from "./registry.js";

const MAX_URL_LENGTH = 2000;
const MAX_MARKDOWN_LENGTH = 100_000;
const MAX_RESPONSE_BYTES = 10 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 60_000;
const MAX_REDIRECTS = 10;
const CACHE_TTL_MS = 15 * 60_000;
const CACHE_MAX_BYTES = 50 * 1024 * 1024;
const USER_AGENT =
  "Mozilla/5.0 (compatible; c-agent/0.1; +https://github.com/) web_fetch";

interface CachedPage {
  expiresAt: number;
  bytes: number;
  status: number;
  statusText: string;
  target: string;
  finalUrl: string;
  markdown: string;
}

const cache = new Map<string, CachedPage>();
let cacheBytes = 0;

function normalizeHostname(hostname: string): string {
  return hostname.toLowerCase().replace(/^www\./, "");
}

export function clearWebFetchCache() {
  cache.clear();
  cacheBytes = 0;
}

export function webFetchCacheSize(): number {
  return cache.size;
}

export function validateWebFetchUrl(url: string): { ok: true; url: URL } | { ok: false; reason: string } {
  if (url.length > MAX_URL_LENGTH) return { ok: false, reason: "URL is too long" };
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, reason: "URL is not parseable" };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:")
    return { ok: false, reason: "URL must use http or https" };
  if (parsed.username || parsed.password)
    return { ok: false, reason: "URL must not contain credentials" };
  if (parsed.hostname.split(".").length < 2)
    return { ok: false, reason: "URL must use a public-looking hostname" };
  return { ok: true, url: parsed };
}

export function isAllowedRedirect(from: URL, to: URL): boolean {
  if (to.protocol !== "http:" && to.protocol !== "https:") return false;
  if (to.username || to.password) return false;
  if (from.protocol !== to.protocol) return false;
  if (from.port !== to.port) return false;
  return normalizeHostname(from.hostname) === normalizeHostname(to.hostname);
}

function cacheGet(target: string): CachedPage | null {
  const hit = cache.get(target);
  if (!hit) return null;
  if (hit.expiresAt <= Date.now()) {
    cache.delete(target);
    cacheBytes -= hit.bytes;
    return null;
  }
  cache.delete(target);
  cache.set(target, hit);
  return hit;
}

function cacheSet(target: string, page: Omit<CachedPage, "expiresAt" | "bytes">) {
  const bytes = Buffer.byteLength(page.markdown, "utf8");
  if (bytes > CACHE_MAX_BYTES) return;
  const old = cache.get(target);
  if (old) cacheBytes -= old.bytes;
  cache.set(target, {
    ...page,
    bytes,
    expiresAt: Date.now() + CACHE_TTL_MS,
  });
  cacheBytes += bytes;
  while (cacheBytes > CACHE_MAX_BYTES) {
    const first = cache.keys().next().value;
    if (!first) break;
    const removed = cache.get(first);
    cache.delete(first);
    if (removed) cacheBytes -= removed.bytes;
  }
}

function isTextualContent(contentType: string): boolean {
  const ct = contentType.toLowerCase().split(";")[0]?.trim() ?? "";
  if (ct.startsWith("text/")) return true;
  return [
    "application/json",
    "application/ld+json",
    "application/xml",
    "application/xhtml+xml",
    "application/rss+xml",
    "application/atom+xml",
    "application/javascript",
  ].includes(ct);
}

/**
 * Lightweight HTML→markdown. Strips script/style/noscript, converts the common
 * block + inline tags, decodes a handful of entities, and collapses blank runs.
 * Not a full turndown — good enough to feed a summarizing model.
 */
function htmlToMarkdown(html: string): string {
  let s = html
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<(script|style|noscript|template)[\s\S]*?<\/\1>/gi, "");

  s = s
    .replace(/<\s*br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|section|article|header|footer|li|tr|h[1-6])\s*>/gi, "\n")
    .replace(/<h([1-6])[^>]*>/gi, (_m, n) => "\n" + "#".repeat(Number(n)) + " ")
    .replace(/<li[^>]*>/gi, "- ")
    .replace(/<(strong|b)[^>]*>(.*?)<\/\1>/gi, "**$2**")
    .replace(/<(em|i)[^>]*>(.*?)<\/\1>/gi, "*$2*")
    .replace(/<code[^>]*>(.*?)<\/code>/gi, "`$1`")
    .replace(/<a\b[^>]*\bhref=["']([^"']*)["'][^>]*>(.*?)<\/a>/gi, "[$2]($1)");

  s = s.replace(/<[^>]+>/g, ""); // drop remaining tags

  s = s
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_m, d) => String.fromCodePoint(Number(d)));

  return s.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

function secondaryPrompt(content: string, prompt: string): string {
  return `Web page content:\n---\n${content}\n---\n\n${prompt}\n\nProvide a concise response based only on the content above. Quote exact language sparingly and use quotation marks for it.`;
}

/** One-shot completion through the agent's provider (no tools, accumulates text). */
async function applyPrompt(
  ctx: ToolContext,
  modelPrompt: string,
  signal?: AbortSignal,
): Promise<string> {
  if (!ctx.provider) return modelPrompt; // no model wired — return raw content
  let out = "";
  const res = await ctx.provider.stream(
    "You answer questions about fetched web content. Be concise and factual.",
    [{ role: "user", content: modelPrompt }],
    [],
    { onText: (d) => (out += d) },
    signal,
  );
  return res.text || out;
}

async function fetchPage(target: string, signal?: AbortSignal): Promise<CachedPage> {
  const cached = cacheGet(target);
  if (cached) return cached;

  const controller = new AbortController();
  const onAbort = () => controller.abort();
  signal?.addEventListener("abort", onAbort);
  const tid = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    let current = new URL(target);
    for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects++) {
      const res = await fetch(current, {
        redirect: "manual",
        signal: controller.signal,
        headers: { Accept: "text/markdown, text/html, text/plain, application/json, */*", "User-Agent": USER_AGENT },
      });

      if (res.status >= 300 && res.status < 400 && res.headers.has("location")) {
        if (redirects === MAX_REDIRECTS) {
          throw new Error(`too many redirects (${MAX_REDIRECTS})`);
        }
        const next = new URL(res.headers.get("location")!, current);
        if (!isAllowedRedirect(current, next)) {
          throw new Error(`blocked cross-domain redirect to ${next.toString()}`);
        }
        current = next;
        continue;
      }

      const contentType = res.headers.get("content-type") ?? "";
      if (!isTextualContent(contentType)) {
        throw new Error(`unsupported non-text content-type: ${contentType || "unknown"}`);
      }
      const contentLength = Number(res.headers.get("content-length") ?? "0");
      if (Number.isFinite(contentLength) && contentLength > MAX_RESPONSE_BYTES) {
        throw new Error(`response too large: ${contentLength} bytes`);
      }

      const bytes = Buffer.from(await res.arrayBuffer());
      if (bytes.byteLength > MAX_RESPONSE_BYTES) {
        throw new Error(`response too large: ${bytes.byteLength} bytes`);
      }

      const raw = bytes.toString("utf8");
      const markdown = contentType.toLowerCase().includes("html")
        ? htmlToMarkdown(raw)
        : raw;
      const page = {
        status: res.status,
        statusText: res.statusText,
        target,
        finalUrl: current.toString(),
        markdown,
      };
      cacheSet(target, page);
      const cachedPage = cacheGet(target);
      return cachedPage ?? { ...page, bytes: Buffer.byteLength(markdown, "utf8"), expiresAt: Date.now() + CACHE_TTL_MS };
    }
    throw new Error(`too many redirects (${MAX_REDIRECTS})`);
  } finally {
    clearTimeout(tid);
    signal?.removeEventListener("abort", onAbort);
  }
}

export const webFetchTool: Tool = {
  risky: true, // network egress — gate per-URL via permission rules
  defer: true,
  searchHint:
    "fetch url web page website docs http https markdown online content documentation",
  maxResultChars: 100_000,
  spec: {
    name: "web_fetch",
    description:
      "Fetch content from a URL and process it with the prompt using the active model. " +
      "Takes a URL and a prompt; fetches the page, converts HTML to markdown, then answers " +
      "the prompt over that content. Read-only, does not modify files. HTTP is upgraded to HTTPS. " +
      "For GitHub URLs prefer the gh CLI via bash.",
    parameters: {
      type: "object",
      properties: {
        url: { type: "string", description: "Fully-formed URL to fetch" },
        prompt: {
          type: "string",
          description: "What to extract from / ask about the page",
        },
      },
      required: ["url", "prompt"],
    },
  },
  async run(input, ctx: ToolContext, signal) {
    const url = String(input.url ?? "");
    const prompt = String(input.prompt ?? "");

    const valid = validateWebFetchUrl(url);
    if (!valid.ok) return { text: `invalid URL: ${url} (${valid.reason})`, isError: true };

    // Upgrade http → https.
    const parsed = valid.url;
    if (parsed.protocol === "http:") parsed.protocol = "https:";
    const target = parsed.toString();

    try {
      const page = await fetchPage(target, signal);

      const truncated =
        page.markdown.length > MAX_MARKDOWN_LENGTH
          ? page.markdown.slice(0, MAX_MARKDOWN_LENGTH) + "\n\n[Content truncated due to length...]"
          : page.markdown;

      const result = await applyPrompt(ctx, secondaryPrompt(truncated, prompt), signal);

      const redirectNote =
        page.finalUrl !== target
          ? `\n\n[Redirected to ${page.finalUrl}]`
          : "";

      return { text: `HTTP ${page.status} ${page.statusText} (${target})\n\n${result}${redirectNote}` };
    } catch (err: any) {
      const aborted = signal?.aborted || err?.name === "AbortError";
      return {
        text: aborted ? "✗ interrupted" : `fetch failed: ${err?.message ?? String(err)}`,
        isError: true,
      };
    }
  },
};

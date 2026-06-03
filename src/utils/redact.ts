import { createHash } from "node:crypto";

interface Detector {
  type: string;
  re: RegExp;
  /** Mask only this capture group instead of the whole match (e.g. value after `password=`). */
  group?: number;
  /** Return true to leave a candidate unmasked (validation / false-positive guard). */
  skip?: (value: string) => boolean;
}

const FILE_EXTS = new Set([
  // source / config
  "js",
  "ts",
  "jsx",
  "tsx",
  "mjs",
  "cjs",
  "json",
  "css",
  "scss",
  "sass",
  "less",
  "html",
  "htm",
  "xml",
  "yaml",
  "yml",
  "md",
  "txt",
  "csv",
  "log",
  "ini",
  "cfg",
  "conf",
  "toml",
  "env",
  "py",
  "rb",
  "go",
  "rs",
  "java",
  "kt",
  "c",
  "h",
  "cpp",
  "cc",
  "hpp",
  "cs",
  "php",
  "pl",
  "sh",
  "bat",
  "ps1",
  // assets / media / archives / binaries
  "png",
  "jpg",
  "jpeg",
  "gif",
  "svg",
  "webp",
  "ico",
  "bmp",
  "tiff",
  "pdf",
  "doc",
  "docx",
  "xls",
  "xlsx",
  "ppt",
  "pptx",
  "zip",
  "tar",
  "gz",
  "tgz",
  "rar",
  "7z",
  "bz2",
  "mp3",
  "mp4",
  "wav",
  "mov",
  "avi",
  "mkv",
  "webm",
  "flac",
  "exe",
  "dll",
  "so",
  "dylib",
  "bin",
  "dat",
  "db",
  "sqlite",
  // common non-domain trailing labels
  "lock",
  "map",
  "min",
  "example",
  "local",
  "dev",
  "test",
  "sample",
  "tmp",
  "bak",
  "old",
]);

/** Luhn check — cuts credit-card false positives (any 13-19 digit run). */
function luhnValid(digits: string): boolean {
  const d = digits.replace(/\D/g, "");
  if (d.length < 13) return false;
  let sum = 0;
  let dbl = false;
  for (let i = d.length - 1; i >= 0; i--) {
    let n = d.charCodeAt(i) - 48;
    if (dbl) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
    dbl = !dbl;
  }
  return sum % 10 === 0;
}

function looksLikeFileOrVersion(v: string): boolean {
  const last = v.split(".").pop()?.toLowerCase() ?? "";
  if (FILE_EXTS.has(last)) return true; // main.py, index.html, app.lock, …
  if (/^\d[\d.]*$/.test(v)) return true; // 1.2.3 (also won't match the [a-z] TLD anyway)
  return false;
}

const looksLikeCode = (v: string) =>
  v.startsWith("_CAGENT_") ||
  v.length < 4 ||
  /^(process|os|import|require|window|globalThis|self|env)\b/.test(v) ||
  /[.$(){}<>]/.test(v);

// Order matters: most specific / structured patterns first so a value is claimed
// by its tightest type; broad/greedy patterns (phone, secret keyword) come last,
// and already-emitted tokens are guarded against re-matching.
const DETECTORS: Detector[] = [
  // --- credentials & secrets (cyber) ---
  {
    type: "PRIVATEKEY",
    re: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g,
  },
  {
    type: "JWT",
    re: /\beyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g,
  },
  { type: "AWSKEY", re: /\bA(?:KIA|SIA|GPA|IDA|ROA|NPA|NVA)[A-Z0-9]{16}\b/g },
  { type: "GHTOKEN", re: /\bgh[pousr]_[A-Za-z0-9]{36,255}\b/g },
  { type: "SLACK", re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g },
  { type: "STRIPE", re: /\b(?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9]{10,}\b/g },
  { type: "GOOGLEKEY", re: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { type: "TWILIO", re: /\bSK[0-9a-fA-F]{32}\b/g },
  { type: "OPENAIKEY", re: /\bsk-[A-Za-z0-9-]{20,}\b/g },
  // user:pass@host inside a connection string / URL
  {
    type: "URLCRED",
    re: /\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:[^\s:/@]+@[^\s/]+/gi,
  },
  // --- web / url ---  (place right after URLCRED so cred-URLs win on overlap)
  {
    // any scheme://… up to whitespace or a closing bracket/quote
    type: "URL",
    re: /\b(?:https?|ftps?|wss?):\/\/[^\s"'<>`(){}\[\]]+/gi,
  },
  // --- contact ---
  { type: "EMAIL", re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g },
  // --- crypto wallets ---
  { type: "ETH", re: /\b0x[a-fA-F0-9]{40}\b/g },
  {
    type: "BTC",
    re: /\b(?:bc1[a-z0-9]{20,60}|[13][a-zA-HJ-NP-Z0-9]{25,39})\b/g,
  },
  // --- finance / national id ---
  { type: "IBAN", re: /\b[A-Z]{2}\d{2}[A-Z0-9]{11,30}\b/g },
  { type: "SSN", re: /\b\d{3}-\d{2}-\d{4}\b/g },
  { type: "CARD", re: /\b(?:\d[ -]?){13,19}\b/g, skip: (v) => !luhnValid(v) },
  // --- network / device ---
  {
    type: "IPV6",
    re: /\b(?:[A-Fa-f0-9]{1,4}:){7}[A-Fa-f0-9]{1,4}\b|\b(?:[A-Fa-f0-9]{1,4}:){1,6}:(?:[A-Fa-f0-9]{1,4}:){0,5}[A-Fa-f0-9]{1,4}\b/g,
  },
  { type: "MAC", re: /\b(?:[0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2}\b/g },
  { type: "IP", re: /\b(?:\d{1,3}\.){3}\d{1,3}\b/g },
  // --- geo ---
  { type: "GPS", re: /-?\d{1,3}\.\d{4,},\s*-?\d{1,3}\.\d{4,}/g },
  // --- phone (greedy, kept late) ---
  {
    type: "PHONE",
    re: /\+?\d{1,3}[-.\s]?\(?\d{2,4}\)?[-.\s]?\d{3,4}[-.\s]?\d{3,4}\b/g,
  },
  // --- keyword=value secrets (catches what structured patterns can't) ---
  {
    type: "SECRET",
    re: /\b(password|passwd|pwd|secret|api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret|bearer)\b["']?\s*[:=]\s*["']?([^\s"',;]+)/gi,
    group: 2,
    skip: looksLikeCode,
  },
  // --- domain (greedy, kept late like PHONE — collides with EMAIL/URL/IP) ---
  {
    type: "DOMAIN",
    re: /\b(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,24}\b/gi,
    skip: looksLikeFileOrVersion,
  },
];

const TOKEN_CHAR = /[A-Za-z0-9_]/;

/**
 * Bidirectional PII vault. Detects sensitive substrings and swaps them for stable
 * opaque tokens; restores tokens back to the real values. Deterministic: the same
 * real value always maps to the same token within a vault instance.
 */
export class Vault {
  readonly sessId: string;
  private realToToken = new Map<string, string>();
  private tokenToReal = new Map<string, string>();

  constructor(seed: string) {
    this.sessId = createHash("sha1").update(seed).digest("hex").slice(0, 4);
  }

  private tokenFor(type: string, real: string): string {
    const existing = this.realToToken.get(real);
    if (existing) return existing;
    const hash = createHash("sha1").update(real).digest("hex").slice(0, 6);
    const token = `_CAGENT_${type}_${this.sessId}_${hash}`;
    this.realToToken.set(real, token);
    this.tokenToReal.set(token, real);
    return token;
  }

  /** Replace detected PII in text with tokens (outbound, to the LLM). */
  redact(text: string): string {
    if (!text) return text;
    let out = text;
    for (const d of DETECTORS) {
      out = out.replace(d.re, (...args: any[]) => {
        const full = args[0] as string;
        const value = d.group ? (args[d.group] as string) : full;
        if (!value || (d.skip && d.skip(value))) return full;
        const token = this.tokenFor(d.type, value);
        // group form keeps the keyword, masks only the captured value
        return d.group ? full.replace(value, token) : token;
      });
    }
    return out;
  }

  /** Replace known tokens with their real values (inbound, from the LLM). */
  restore(text: string): string {
    if (!text || this.tokenToReal.size === 0) return text;
    let out = text;
    for (const [token, real] of this.tokenToReal) {
      if (out.includes(token)) out = out.split(token).join(real);
    }
    return out;
  }

  get size(): number {
    return this.tokenToReal.size;
  }
}

/** Deep-redact every string in a JSON-ish value (for tool-call args, etc.). */
export function deepRedact(value: any, vault: Vault): any {
  if (typeof value === "string") return vault.redact(value);
  if (Array.isArray(value)) return value.map((v) => deepRedact(v, vault));
  if (value && typeof value === "object") {
    const out: Record<string, any> = {};
    for (const [k, v] of Object.entries(value)) out[k] = deepRedact(v, vault);
    return out;
  }
  return value;
}

/** Deep-restore every string in a JSON-ish value (for tool-call args the LLM emits). */
export function deepRestore(value: any, vault: Vault): any {
  if (typeof value === "string") return vault.restore(value);
  if (Array.isArray(value)) return value.map((v) => deepRestore(v, vault));
  if (value && typeof value === "object") {
    const out: Record<string, any> = {};
    for (const [k, v] of Object.entries(value)) out[k] = deepRestore(v, vault);
    return out;
  }
  return value;
}

/**
 * Restores tokens in a token stream safely: a token may be split across deltas,
 * so the trailing run of token-legal chars is held back until a boundary arrives.
 */
export class StreamRestorer {
  private buf = "";
  constructor(private vault: Vault) {}

  push(delta: string): string {
    this.buf += delta;
    let i = this.buf.length;
    while (i > 0 && TOKEN_CHAR.test(this.buf[i - 1])) i--;
    const emit = this.buf.slice(0, i);
    this.buf = this.buf.slice(i);
    return this.vault.restore(emit);
  }

  flush(): string {
    const out = this.vault.restore(this.buf);
    this.buf = "";
    return out;
  }
}

export interface UndercoverState {
  enabled: boolean;
  vault: Vault;
}

export function undercoverSystem(sessId: string): string {
  return (
    `\n\n<undercover-mode>\n` +
    `Privacy mode is active. Sensitive values in this conversation have been replaced with opaque ` +
    `placeholder tokens shaped like _CAGENT_<TYPE>_${sessId}_<hash> ` +
    `(e.g. _CAGENT_EMAIL_${sessId}_9f3c1d). Each token stands for a real value you are not allowed to see.\n` +
    `Rules:\n` +
    `- Treat every such token as an opaque handle. Reason about it normally.\n` +
    `- When you must refer to or act on that value — in your reply OR in tool arguments — output the ` +
    `EXACT token, character for character. Do NOT alter, complete, decode, or guess the real value.\n` +
    `- Never invent tokens. Only use tokens that already appear in the conversation.\n` +
    `</undercover-mode>`
  );
}

import { appendFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { ensureSecureDir } from "./secure-fs.js";

const AUDIT_LOG = join(homedir(), ".c-agent", "audit.log");
const DIAG_LOG = join(homedir(), ".c-agent", "diagnostics.log");
const PREVIEW_MAX = 500;

/** Append one JSON line to a 0600 log. Never throws (best-effort). */
function appendLine(file: string, obj: Record<string, unknown>): void {
  try {
    ensureSecureDir(dirname(file));
    appendFileSync(file, JSON.stringify({ ts: new Date().toISOString(), ...obj }) + "\n", {
      mode: 0o600,
    });
  } catch {
    /* logging must never break the agent */
  }
}

/**
 * Append-only audit trail of tool dispatch + permission decisions, for gov
 * compliance and incident response. Stored 0600 at ~/.c-agent/audit.log.
 */
export function audit(entry: {
  tool: string;
  decision: string;
  preview?: string;
  isError?: boolean;
}): void {
  appendLine(AUDIT_LOG, {
    tool: entry.tool,
    decision: entry.decision,
    ...(entry.preview ? { preview: entry.preview.slice(0, PREVIEW_MAX) } : {}),
    ...(entry.isError ? { isError: true } : {}),
  });
}

/** Diagnostics log for crashes — error name/message/stack only, no PII args. */
export function diag(event: string, reason: unknown): void {
  const info =
    reason instanceof Error
      ? { error_name: reason.name, error_message: reason.message?.slice(0, 2000), stack: reason.stack?.slice(0, 4000) }
      : { error_message: String(reason).slice(0, 2000) };
  appendLine(DIAG_LOG, { level: "error", event, ...info });
}

import type { PermissionSettings } from "./settings.js";

export type Mode = "default" | "acceptEdits" | "plan" | "bypass";
export const MODES: Mode[] = ["default", "acceptEdits", "plan", "bypass"];

export type Eval = "allow" | "deny" | "ask";

/** Tools that mutate files — auto-approved in acceptEdits mode. */
const EDIT_TOOLS = new Set(["write", "edit", "multi_edit"]);

interface Rule {
  tool: string; // lowercase tool name
  matcher: RegExp | null; // null = match any input
}

/** The string compared against a rule's argument matcher, per tool. */
function ruleTarget(tool: string, input: any): string {
  if (tool === "bash") return String(input?.command ?? "");
  if (input?.url) {
    try {
      return new URL(String(input.url)).toString();
    } catch {
      return String(input.url);
    }
  }
  if (input?.path) return String(input.path);
  if (input?.pattern) return String(input.pattern);
  try {
    return JSON.stringify(input ?? {});
  } catch {
    return "";
  }
}

/** Parse `Tool` or `Tool(spec)`. spec uses `*` wildcards; `:*` means prefix. */
function parseRule(raw: string): Rule | null {
  const m = raw.match(/^([A-Za-z_][\w]*)(?:\((.*)\))?$/s);
  if (!m) return null;
  const tool = m[1].toLowerCase();
  const spec = m[2];
  if (spec === undefined || spec === "" || spec === "*") {
    return { tool, matcher: null };
  }
  // `npm:*` (prefix form) and `npm *` both behave as a prefix/glob.
  const glob = spec.replace(/:\*/g, "*");
  const re =
    "^" +
    glob.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") +
    "$";
  return { tool, matcher: new RegExp(re) };
}

function matchesTarget(rules: Rule[], tool: string, target: string): boolean {
  for (const r of rules) {
    if (r.tool !== tool) continue;
    if (r.matcher === null || r.matcher.test(target)) return true;
  }
  return false;
}

function matches(rules: Rule[], tool: string, input: any): boolean {
  return matchesTarget(rules, tool, ruleTarget(tool, input));
}

/**
 * Split a shell command into the individual commands it would execute, so each
 * can be matched against permission rules on its own. Quote- and escape-aware:
 * splits on unquoted `;`, `|`, `&`, `&&`, `||`, and newlines, descends into
 * `$( )`, backticks, and process substitution, and treats `( ) { }` grouping as
 * boundaries.
 *
 * Deliberately over-splits — surfacing MORE executable fragments is the safe
 * direction for both checks: deny fires if ANY fragment is denied, and a
 * blanket allow requires EVERY fragment to be allowed. Without this, a rule like
 * `bash(git commit:*)` matched the whole line, so `git commit -m x && rm -rf ~`
 * was auto-approved, and a deny like `bash(rm:*)` was evaded by `x && rm …`.
 *
 * Returns [] for an empty command.
 */
export function bashSegments(command: string): string[] {
  const segments: string[] = [];
  let buf = "";
  let i = 0;
  const n = command.length;

  const flush = () => {
    const t = buf.trim();
    if (t) segments.push(t);
    buf = "";
  };
  const descend = (body: string) => {
    for (const s of bashSegments(body)) segments.push(s);
  };

  while (i < n) {
    const ch = command[i]!;

    // Backslash escape (outside single quotes): keep the next char literally.
    if (ch === "\\") {
      buf += ch + (command[i + 1] ?? "");
      i += 2;
      continue;
    }

    // Single quotes: fully literal — no separators, no substitution.
    if (ch === "'") {
      const end = command.indexOf("'", i + 1);
      if (end < 0) {
        buf += command.slice(i);
        break;
      }
      buf += command.slice(i, end + 1);
      i = end + 1;
      continue;
    }

    // Double quotes: literal except embedded $( ) / backtick substitutions,
    // whose inner commands are extracted as their own segments.
    if (ch === '"') {
      let j = i + 1;
      while (j < n && command[j] !== '"') {
        if (command[j] === "\\") {
          j += 2;
          continue;
        }
        if (command[j] === "$" && command[j + 1] === "(") {
          const { body, end } = extractParen(command, j + 1);
          descend(body);
          j = end;
          continue;
        }
        if (command[j] === "`") {
          const end = command.indexOf("`", j + 1);
          if (end < 0) {
            j = n;
            break;
          }
          descend(command.slice(j + 1, end));
          j = end + 1;
          continue;
        }
        j++;
      }
      buf += command.slice(i, Math.min(j + 1, n));
      i = j + 1;
      continue;
    }

    // $( ) command substitution at top level.
    if (ch === "$" && command[i + 1] === "(") {
      const { body, end } = extractParen(command, i + 1);
      descend(body);
      i = end;
      continue;
    }

    // Backtick command substitution.
    if (ch === "`") {
      const end = command.indexOf("`", i + 1);
      if (end < 0) break;
      descend(command.slice(i + 1, end));
      i = end + 1;
      continue;
    }

    // Subshell `( )` and process substitution `<( )` / `>( )`.
    if (ch === "(" || ((ch === "<" || ch === ">") && command[i + 1] === "(")) {
      const open = ch === "(" ? i : i + 1;
      const { body, end } = extractParen(command, open);
      flush();
      descend(body);
      i = end;
      continue;
    }

    // Command separators.
    if (ch === "\n" || ch === ";") {
      flush();
      i++;
      continue;
    }
    if (ch === "&" || ch === "|") {
      flush();
      i++;
      while (command[i] === "&" || command[i] === "|") i++; // &&, ||, |&
      continue;
    }

    // Grouping boundaries.
    if (ch === "{" || ch === "}" || ch === ")") {
      flush();
      i++;
      continue;
    }

    buf += ch;
    i++;
  }
  flush();
  return segments;
}

/** Body between the matched `( )` starting at `openIdx`, and the index past `)`. */
function extractParen(s: string, openIdx: number): { body: string; end: number } {
  let depth = 0;
  for (let k = openIdx; k < s.length; k++) {
    if (s[k] === "(") depth++;
    else if (s[k] === ")") {
      depth--;
      if (depth === 0) return { body: s.slice(openIdx + 1, k), end: k + 1 };
    }
  }
  return { body: s.slice(openIdx + 1), end: s.length };
}

// ---------------------------------------------------------------------------
// Per-command rule suggestion (bash only)
// ---------------------------------------------------------------------------

export interface RuleSuggestion {
  /** Permission-rule spec string, e.g. "bash(git commit:*)". */
  spec: string;
  /** Short human label shown in the "Always allow …" option. */
  label: string;
}

/**
 * Shells/wrappers whose first word would make a prefix rule equivalent to
 * allowing arbitrary code. Never suggest a reusable prefix for these.
 */
const BARE_SHELL_PREFIXES = new Set([
  "sh", "bash", "zsh", "fish", "csh", "tcsh", "ksh", "dash",
  "cmd", "powershell", "pwsh",
  "env", "xargs", "nice", "stdbuf", "nohup", "timeout", "time",
  "sudo", "doas", "pkexec",
]);

/** Matches a real subcommand token: lowercase alpha+digits, optional hyphens. */
const SUBCMD_RE = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;

/**
 * Extract a stable 2-word prefix ("git commit", "npm run") from a command.
 * Returns null when no clean subcommand is present (flags, paths, numbers).
 * Mirrors Claude Code's getSimpleCommandPrefix: conservative backend logic,
 * avoids broad rules like `rm:*` or `ls:*`.
 */
function simpleCommandPrefix(command: string): string | null {
  const tokens = command.trim().split(/\s+/).filter(Boolean);
  if (tokens.length < 2) return null;
  // Leading env-var assignment (VAR=val) → not matchable as a prefix, bail.
  if (/^[A-Za-z_]\w*=/.test(tokens[0]!)) return null;
  const cmd = tokens[0]!;
  const sub = tokens[1]!;
  if (!SUBCMD_RE.test(cmd) || BARE_SHELL_PREFIXES.has(cmd)) return null;
  if (!SUBCMD_RE.test(sub)) return null; // flag / path / number / filename
  return `${cmd} ${sub}`;
}

// ---------------------------------------------------------------------------

export class PermissionEngine {
  mode: Mode;
  private allow: Rule[];
  private deny: Rule[];
  /** Rules granted "always" this session (per-command or per-tool). */
  private sessionAllow: Rule[] = [];

  constructor(settings: PermissionSettings, mode?: Mode) {
    this.allow = (settings.allow ?? []).map(parseRule).filter(Boolean) as Rule[];
    this.deny = (settings.deny ?? []).map(parseRule).filter(Boolean) as Rule[];
    this.mode = mode ?? (MODES.includes(settings.mode as Mode) ? (settings.mode as Mode) : "default");
  }

  /** Grant the whole tool for the rest of this session. */
  grantAlways(tool: string) {
    this.sessionAllow.push({ tool: tool.toLowerCase(), matcher: null });
  }

  /**
   * Grant a specific rule (e.g. "bash(git commit:*)") for the rest of this
   * session. Falls back to a whole-tool grant if the spec can't be parsed.
   */
  grantRule(spec: string, toolFallback: string) {
    const r = parseRule(spec);
    if (r) {
      this.sessionAllow.push(r);
    } else {
      this.grantAlways(toolFallback);
    }
  }

  /**
   * Suggest a reusable permission rule for this call.
   * Returns null when no safe per-command rule can be derived (falls back to
   * whole-tool "always allow" in the caller).
   *
   * For bash: derives a 2-word subcommand prefix ("git commit", "npm run")
   * when possible; otherwise suggests the exact single-line command.
   * Multiline commands and env-var-prefixed commands return null.
   */
  suggestRule(tool: string, input: any): RuleSuggestion | null {
    if (tool === "web_fetch") {
      try {
        const url = new URL(String(input?.url ?? ""));
        return {
          spec: `web_fetch(*://${url.hostname}/*)`,
          label: url.hostname,
        };
      } catch {
        return null;
      }
    }

    if (tool !== "bash") return null;

    const command = String(input?.command ?? "").trim();
    if (!command || command.includes("\n")) return null;

    // Leading env-var → we can't form a matchable prefix (ruleTarget returns
    // the raw command; cagent doesn't strip env vars at match time).
    if (/^[A-Za-z_]\w*=/.test(command)) return null;

    const prefix = simpleCommandPrefix(command);
    if (prefix) {
      return {
        spec: `bash(${prefix}:*)`,
        label: prefix,
      };
    }

    // Exact-command rule: only re-matches that identical invocation, but that
    // beats granting all of bash. Safe for single-use commands (rm, dd, …).
    // Only offered for a single-segment command — a chained command is matched
    // per segment, so an exact whole-line rule could never re-match it anyway.
    if (bashSegments(command).length > 1) return null;
    const shortCmd = command.length > 50 ? command.slice(0, 50) + "…" : command;
    return {
      spec: `bash(${command})`,
      label: shortCmd,
    };
  }

  /** Decide allow/deny/ask for a tool call. `risky` = tool mutates state. */
  evaluate(tool: string, input: any, risky: boolean): Eval {
    if (tool === "bash") return this.evaluateBash(input, risky);

    if (matches(this.deny, tool, input)) return "deny";
    if (this.mode === "bypass") return "allow";
    if (matches(this.allow, tool, input)) return "allow";
    if (matches(this.sessionAllow, tool, input)) return "allow";
    if (!risky) return "allow";

    // risky from here
    if (this.mode === "plan") return "deny"; // plan mode: no mutations
    if (this.mode === "acceptEdits" && EDIT_TOOLS.has(tool)) return "allow";
    return "ask";
  }

  /**
   * Bash is evaluated per executable segment so a rule can't be escaped (or
   * abused) by command chaining: deny if ANY segment is denied, and treat the
   * call as rule-allowed only if EVERY segment is allowed by an allow rule. A
   * command that won't parse into segments is never auto-allowed by rules.
   */
  private evaluateBash(input: any, risky: boolean): Eval {
    const command = String(input?.command ?? "");
    const segments = bashSegments(command);
    const denyTargets = segments.length > 0 ? segments : [command];
    if (denyTargets.some((seg) => matchesTarget(this.deny, "bash", seg))) return "deny";

    if (this.mode === "bypass") return "allow";

    const allowRules = [...this.allow, ...this.sessionAllow];
    const allowedByRules =
      segments.length > 0 &&
      segments.every((seg) => matchesTarget(allowRules, "bash", seg));
    if (allowedByRules) return "allow";

    if (!risky) return "allow";
    if (this.mode === "plan") return "deny"; // plan mode: no mutations
    return "ask"; // acceptEdits applies to edit tools only, not bash
  }
}

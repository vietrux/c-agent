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
  const m = raw.match(/^([A-Za-z_][\w]*)(?:\((.*)\))?$/);
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

function matches(rules: Rule[], tool: string, input: any): boolean {
  const target = ruleTarget(tool, input);
  for (const r of rules) {
    if (r.tool !== tool) continue;
    if (r.matcher === null || r.matcher.test(target)) return true;
  }
  return false;
}

export class PermissionEngine {
  mode: Mode;
  private allow: Rule[];
  private deny: Rule[];
  private sessionAllow = new Set<string>(); // tool names granted "always" this session

  constructor(settings: PermissionSettings, mode?: Mode) {
    this.allow = (settings.allow ?? []).map(parseRule).filter(Boolean) as Rule[];
    this.deny = (settings.deny ?? []).map(parseRule).filter(Boolean) as Rule[];
    this.mode = mode ?? (MODES.includes(settings.mode as Mode) ? (settings.mode as Mode) : "default");
  }

  grantAlways(tool: string) {
    this.sessionAllow.add(tool);
  }

  /** Decide allow/deny/ask for a tool call. `risky` = tool mutates state. */
  evaluate(tool: string, input: any, risky: boolean): Eval {
    if (matches(this.deny, tool, input)) return "deny";
    if (this.mode === "bypass") return "allow";
    if (matches(this.allow, tool, input)) return "allow";
    if (this.sessionAllow.has(tool)) return "allow";
    if (!risky) return "allow";

    // risky from here
    if (this.mode === "plan") return "deny"; // plan mode: no mutations
    if (this.mode === "acceptEdits" && EDIT_TOOLS.has(tool)) return "allow";
    return "ask";
  }
}

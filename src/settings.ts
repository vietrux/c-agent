import { homedir } from "node:os";
import { join } from "node:path";
import { readFileSync, existsSync } from "node:fs";

export interface McpServerConfig {
  /** Transport. Inferred when omitted: `url` → http, else stdio. */
  type?: "stdio" | "http" | "sse";
  // stdio
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  // http / sse
  url?: string;
  headers?: Record<string, string>;
  /** Per-request timeout in ms (default 60000). */
  timeout?: number;
}

export interface PermissionSettings {
  allow?: string[];
  deny?: string[];
  mode?: string;
}

export interface HookDef {
  matcher?: string; // regex on tool name (tool events only); absent = match all
  command: string;
}

export type HookEvent =
  | "PreToolUse"
  | "PostToolUse"
  | "UserPromptSubmit"
  | "Stop"
  | "SubagentStop"
  | "SessionStart";
export type HookConfig = Partial<Record<HookEvent, HookDef[]>>;

export interface ProviderConfig {
  /** Wire format. openai = OpenAI-compatible (OpenAI, NIM, vLLM, local). */
  type?: "openai" | "anthropic";
  baseURL?: string;
  /** API key inline, or name an env var via apiKeyEnv (preferred). */
  apiKey?: string;
  apiKeyEnv?: string;
  /** Omit to choose interactively from the provider's model list. */
  model?: string;
}

export interface Settings {
  permissions: PermissionSettings;
  mcpServers: Record<string, McpServerConfig>;
  hooks: HookConfig;
  /** Primary/active provider. */
  provider?: ProviderConfig;
  /** Extra named providers, shown grouped in the /model picker. */
  providers: Record<string, ProviderConfig>;
}

function readJson(path: string): any | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

/**
 * Merge settings from (low→high precedence):
 *   ~/.c-agent/settings.json, <cwd>/.c-agent/settings.json, <cwd>/.mcp.json
 * Arrays concatenate; mode takes the last defined value.
 */
export function loadSettings(cwd: string): Settings {
  const sources = [
    readJson(join(homedir(), ".c-agent", "settings.json")),
    readJson(join(cwd, ".c-agent", "settings.json")),
  ].filter(Boolean);

  const allow: string[] = [];
  const deny: string[] = [];
  let mode: string | undefined;
  const mcpServers: Record<string, McpServerConfig> = {};
  const hooks: HookConfig = {};
  let provider: ProviderConfig | undefined;
  const providers: Record<string, ProviderConfig> = {};

  for (const s of sources) {
    const p = s.permissions ?? {};
    if (Array.isArray(p.allow)) allow.push(...p.allow);
    if (Array.isArray(p.deny)) deny.push(...p.deny);
    if (typeof p.mode === "string") mode = p.mode;
    if (s.mcpServers) Object.assign(mcpServers, s.mcpServers);
    if (s.hooks && typeof s.hooks === "object") {
      for (const [event, defs] of Object.entries(s.hooks)) {
        if (!Array.isArray(defs)) continue;
        (hooks[event as HookEvent] ??= []).push(...(defs as HookDef[]));
      }
    }
    if (s.provider && typeof s.provider === "object") {
      provider = { ...(provider ?? {}), ...s.provider }; // later source overrides
    }
    if (s.providers && typeof s.providers === "object") Object.assign(providers, s.providers);
  }

  // .mcp.json holds only mcpServers
  const mcpFile = readJson(join(cwd, ".mcp.json"));
  if (mcpFile?.mcpServers) Object.assign(mcpServers, mcpFile.mcpServers);

  return { permissions: { allow, deny, mode }, mcpServers, hooks, provider, providers };
}

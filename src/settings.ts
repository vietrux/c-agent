import { homedir } from "node:os";
import { join } from "node:path";
import { readFileSync, existsSync } from "node:fs";
import type { ProviderRequestParams } from "./provider/types.js";

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

export interface ModelConfig {
  id: string;
  params?: ProviderRequestParams;
}

export type ModelEntryConfig = string | ModelConfig;

export interface ProviderConfig {
  /** Wire format. openai = OpenAI-compatible (OpenAI, NIM, vLLM, local). */
  type?: "openai" | "anthropic";
  baseURL?: string;
  /** API key inline, or name an env var via apiKeyEnv (preferred). */
  apiKey?: string;
  apiKeyEnv?: string;
  /** Omit to choose interactively from the provider's model list. */
  model?: ModelEntryConfig;
  /** Additional static model ids to show in the TUI picker. */
  models?: ModelEntryConfig[];
  /** Provider-specific defaults merged into every request payload. */
  params?: ProviderRequestParams;
  /** Provider-specific params keyed by model id. */
  modelParams?: Record<string, ProviderRequestParams>;
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

function isPlainRecord(value: unknown): value is Record<string, any> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function uniqueStrings(items: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of items) {
    const id = item.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

export function providerModelId(model: ProviderConfig["model"]): string | undefined {
  if (typeof model === "string") return model.trim() || undefined;
  if (isPlainRecord(model) && typeof model.id === "string") return model.id.trim() || undefined;
  return undefined;
}

export function configuredModelIds(cfg: ProviderConfig): string[] {
  const ids: string[] = [];
  const primary = providerModelId(cfg.model);
  if (primary) ids.push(primary);
  if (Array.isArray(cfg.models)) {
    for (const model of cfg.models) {
      const id = providerModelId(model);
      if (id) ids.push(id);
    }
  }
  if (isPlainRecord(cfg.modelParams)) ids.push(...Object.keys(cfg.modelParams));
  return uniqueStrings(ids);
}

function mergeModelParam(
  out: Record<string, ProviderRequestParams>,
  id: string | undefined,
  params: unknown,
): void {
  if (!id || !isPlainRecord(params)) return;
  out[id] = { ...(out[id] ?? {}), ...params };
}

export function configuredModelParams(cfg: ProviderConfig): Record<string, ProviderRequestParams> {
  const out: Record<string, ProviderRequestParams> = {};
  if (isPlainRecord(cfg.modelParams)) {
    for (const [id, params] of Object.entries(cfg.modelParams)) {
      mergeModelParam(out, id.trim(), params);
    }
  }
  if (isPlainRecord(cfg.model)) mergeModelParam(out, providerModelId(cfg.model), cfg.model.params);
  if (Array.isArray(cfg.models)) {
    for (const model of cfg.models) {
      if (isPlainRecord(model)) mergeModelParam(out, providerModelId(model), model.params);
    }
  }
  return out;
}

export function providerParams(cfg: ProviderConfig): ProviderRequestParams {
  return isPlainRecord(cfg.params) ? { ...cfg.params } : {};
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

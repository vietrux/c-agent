import { OpenAIProvider } from "./openai.js";
import { AnthropicProvider } from "./anthropic.js";
import type { Provider } from "./types.js";
import {
  configuredModelParams,
  providerModelId,
  providerParams,
  type ProviderConfig,
} from "../settings.js";

export * from "./types.js";

export interface ResolvedProvider {
  provider: Provider;
  /** True when no model was configured — the UI should prompt for one. */
  needsModel: boolean;
}

/**
 * Build a provider from a settings.json provider config. Key comes from
 * config.apiKey, or the env var named by config.apiKeyEnv (default
 * ANTHROPIC_API_KEY / OPENAI_API_KEY by type). No model => needsModel so the
 * TUI can prompt for one.
 */
export function resolveProvider(cfg: ProviderConfig): ResolvedProvider {
  const type = cfg.type ?? "openai";
  const defaultKeyEnv = type === "anthropic" ? "ANTHROPIC_API_KEY" : "OPENAI_API_KEY";
  const rawApiKey = cfg.apiKey ?? process.env[cfg.apiKeyEnv ?? defaultKeyEnv];
  const noAuthCustomProvider = cfg.apiKey === "" && !!cfg.baseURL;
  if (!rawApiKey && !noAuthCustomProvider) {
    throw new Error(
      `missing API key for provider "${type}" — set apiKey, apiKeyEnv, or ${defaultKeyEnv}`,
    );
  }
  const apiKey = rawApiKey || "local";
  const model = providerModelId(cfg.model) ?? "";
  const opts = {
    apiKey,
    model,
    baseURL: cfg.baseURL,
    params: providerParams(cfg),
    modelParams: configuredModelParams(cfg),
  };
  const provider =
    type === "anthropic" ? new AnthropicProvider(opts) : new OpenAIProvider(opts);
  return { provider, needsModel: !model };
}

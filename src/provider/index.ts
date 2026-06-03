import { OpenAIProvider } from "./openai.js";
import { AnthropicProvider } from "./anthropic.js";
import type { Provider } from "./types.js";
import type { ProviderConfig } from "../settings.js";

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
  const apiKey = cfg.apiKey ?? process.env[cfg.apiKeyEnv ?? defaultKeyEnv];
  if (!apiKey) {
    throw new Error(
      `missing API key for provider "${type}" — set apiKey, apiKeyEnv, or ${defaultKeyEnv}`,
    );
  }
  const model = cfg.model ?? "";
  const opts = { apiKey, model, baseURL: cfg.baseURL };
  const provider =
    type === "anthropic" ? new AnthropicProvider(opts) : new OpenAIProvider(opts);
  return { provider, needsModel: !model };
}

export interface ToolSpec {
  name: string;
  description: string;
  parameters: Record<string, any>; // JSON schema (object)
}

export interface ToolCall {
  id: string;
  name: string;
  input: any; // parsed object
}

export type NeutralMessage =
  | { role: "user"; content: string }
  // `reasoning` is the model's thinking trace — persisted for display/resume
  // only; providers ignore it when building wire messages.
  | { role: "assistant"; content: string; toolCalls: ToolCall[]; reasoning?: string }
  | { role: "tool"; results: { id: string; content: string; isError: boolean }[] }
  // Harness-injected context (e.g. background-task completions). Own transcript
  // entry + own UI block — never folded into the user's message.
  | { role: "note"; content: string };

export interface StreamHandlers {
  onText(delta: string): void;
  /** Reasoning/thinking tokens (NIM reasoning_content, etc). Optional. */
  onReasoning?(delta: string): void;
  /**
   * A complete tool call became available before the final response resolved.
   * Providers that cannot safely detect this early may call it at the end or not
   * at all; the agent deduplicates against the final tool call list.
   */
  onToolCallReady?(toolCall: ToolCall): void;
}

export interface Usage {
  input: number;
  output: number;
  cached: number;
}

export interface StreamResult {
  text: string;
  toolCalls: ToolCall[];
  usage: Usage;
}

export type ProviderRequestParams = Record<string, any>;

/** A model backend. Owns conversion from neutral transcript to its wire format. */
export interface Provider {
  model: string; // mutable: may be chosen/switched at runtime
  /** Wire dialect, so UIs can shape provider-specific params (e.g. /effort). */
  readonly kind?: "openai" | "anthropic";
  stream(
    system: string,
    messages: NeutralMessage[],
    tools: ToolSpec[],
    handlers: StreamHandlers,
    signal?: AbortSignal,
  ): Promise<StreamResult>;
  /** Current provider-specific request params for the selected model. */
  getRequestParams?(): ProviderRequestParams;
  /**
   * Merge a runtime override into the request params (highest precedence, above
   * config defaults and per-model params). Used by /effort to tune reasoning at
   * runtime. Shallow per top-level key.
   */
  setRuntimeParams?(patch: ProviderRequestParams): void;
  /** List selectable model ids, if the backend supports it. */
  listModels?(): Promise<string[]>;
}

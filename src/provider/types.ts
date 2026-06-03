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
  | { role: "assistant"; content: string; toolCalls: ToolCall[] }
  | { role: "tool"; results: { id: string; content: string; isError: boolean }[] }
  // Harness-injected context (e.g. background-task completions). Own transcript
  // entry + own UI block — never folded into the user's message.
  | { role: "note"; content: string };

export interface StreamHandlers {
  onText(delta: string): void;
  /** Reasoning/thinking tokens (NIM reasoning_content, etc). Optional. */
  onReasoning?(delta: string): void;
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

/** A model backend. Owns conversion from neutral transcript to its wire format. */
export interface Provider {
  model: string; // mutable: may be chosen/switched at runtime
  stream(
    system: string,
    messages: NeutralMessage[],
    tools: ToolSpec[],
    handlers: StreamHandlers,
    signal?: AbortSignal,
  ): Promise<StreamResult>;
  /** List selectable model ids, if the backend supports it. */
  listModels?(): Promise<string[]>;
}

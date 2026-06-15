import Anthropic from "@anthropic-ai/sdk";
import type {
  Provider,
  NeutralMessage,
  ToolSpec,
  StreamHandlers,
  StreamResult,
  ToolCall,
  Usage,
  ProviderRequestParams,
} from "./types.js";
import {
  applyRequestParams,
  paramsForModel,
  sanitizeModelParams,
  sanitizeParams,
} from "./params.js";

export class AnthropicProvider implements Provider {
  readonly kind = "anthropic" as const;
  private client: Anthropic;
  private _model: string;
  private defaultParams: ProviderRequestParams;
  private modelParams: Record<string, ProviderRequestParams>;
  // Runtime overrides (e.g. /effort) — highest precedence, not persisted.
  private runtimeParams: ProviderRequestParams = {};

  constructor(opts: {
    apiKey: string;
    baseURL?: string;
    model: string;
    params?: ProviderRequestParams;
    modelParams?: Record<string, ProviderRequestParams>;
  }) {
    // c-agent owns stream retries so retry timing is visible and Esc can stop waits.
    this.client = new Anthropic({ apiKey: opts.apiKey, baseURL: opts.baseURL, maxRetries: 0 });
    this._model = opts.model;
    this.defaultParams = sanitizeParams(opts.params);
    this.modelParams = sanitizeModelParams(opts.modelParams);
  }

  get model(): string {
    return this._model;
  }

  set model(model: string) {
    this._model = model;
  }

  getRequestParams(): ProviderRequestParams {
    return {
      ...paramsForModel(this.defaultParams, this.modelParams, this.model),
      ...this.runtimeParams,
    };
  }

  setRuntimeParams(patch: ProviderRequestParams): void {
    Object.assign(this.runtimeParams, sanitizeParams(patch));
  }

  async listModels(): Promise<string[]> {
    const ids: string[] = [];
    for await (const m of this.client.models.list()) ids.push(m.id);
    return ids;
  }

  private toWire(messages: NeutralMessage[]): Anthropic.MessageParam[] {
    // Drop empty assistant turns (no text, no tool calls): they map to an empty
    // content array, which the API rejects. Lets a transcript left malformed by
    // an interrupted turn still be re-sent.
    const usable = messages.filter(
      (m) => !(m.role === "assistant" && !m.content && m.toolCalls.length === 0),
    );
    const mapped = usable.map((m): Anthropic.MessageParam => {
      // Notes carry harness context; deliver as a tagged user message.
      if (m.role === "note") {
        return { role: "user", content: `<context>\n${m.content}\n</context>` };
      }
      if (m.role === "user") {
        return { role: "user", content: m.content };
      }
      if (m.role === "assistant") {
        const blocks: Anthropic.ContentBlockParam[] = [];
        if (m.content) blocks.push({ type: "text", text: m.content });
        for (const tc of m.toolCalls) {
          blocks.push({ type: "tool_use", id: tc.id, name: tc.name, input: tc.input ?? {} });
        }
        return { role: "assistant", content: blocks };
      }
      return {
        role: "user",
        content: m.results.map((r) => ({
          type: "tool_result" as const,
          tool_use_id: r.id,
          content: r.content,
          is_error: r.isError,
        })),
      };
    });
    return mergeConsecutive(mapped);
  }

  async stream(
    system: string,
    messages: NeutralMessage[],
    tools: ToolSpec[],
    handlers: StreamHandlers,
    signal?: AbortSignal,
  ): Promise<StreamResult> {
    const wireMessages = this.toWire(messages);
    // Prompt caching: one breakpoint after system+tools (the large static
    // prefix) and one on the last message (the running conversation). Each turn
    // only the new tail is uncached — big cost/latency win on repeat requests.
    // Markers are ignored below the model's minimum cacheable size, so this is
    // always safe to send.
    applyCacheBreakpoint(wireMessages);
    const payload = applyRequestParams(
      {
        model: this.model,
        max_tokens: 8192,
        system: [
          { type: "text", text: system, cache_control: { type: "ephemeral" } },
        ],
        tools: tools.map((t) => ({
          name: t.name,
          description: t.description,
          input_schema: t.parameters as Anthropic.Tool.InputSchema,
        })),
        messages: wireMessages,
      },
      this.getRequestParams(),
      ["model", "messages", "system", "tools"],
    );
    const stream = this.client.messages.stream(payload as any, { signal });
    let reasoningEmitted = false;
    stream.on("thinking", (d) => {
      reasoningEmitted = true;
      handlers.onReasoning?.(d);
    });
    stream.on("text", (d) => handlers.onText(d));
    stream.on("contentBlock", (block) => {
      if (block.type !== "tool_use") return;
      handlers.onToolCallReady?.({
        id: block.id,
        name: block.name,
        input: block.input,
      });
    });

    const final = await stream.finalMessage();
    let text = "";
    const toolCalls: ToolCall[] = [];
    for (const block of final.content) {
      if (block.type === "text") text += block.text;
      else if (block.type === "thinking") {
        if (!reasoningEmitted) handlers.onReasoning?.(block.thinking);
      } else if (block.type === "tool_use") {
        toolCalls.push({ id: block.id, name: block.name, input: block.input });
      }
    }
    // Real prompt size = uncached + cache-read + cache-creation. With caching on,
    // `input_tokens` alone is only the uncached tail, so it must be summed or the
    // footer and context accounting would massively undercount the window.
    const u = final.usage;
    const usage: Usage = {
      input:
        (u.input_tokens ?? 0) +
        (u.cache_read_input_tokens ?? 0) +
        (u.cache_creation_input_tokens ?? 0),
      output: u.output_tokens ?? 0,
      cached: u.cache_read_input_tokens ?? 0,
    };
    return { text, toolCalls, usage };
  }
}

/** Put an ephemeral cache breakpoint on the last block of the last message. */
function applyCacheBreakpoint(msgs: Anthropic.MessageParam[]): void {
  const last = msgs[msgs.length - 1];
  if (!last) return;
  const blocks = toBlocks(last.content).map((b) => ({ ...b }));
  if (blocks.length === 0) return;
  blocks[blocks.length - 1] = {
    ...blocks[blocks.length - 1],
    cache_control: { type: "ephemeral" },
  } as Anthropic.ContentBlockParam;
  last.content = blocks;
}

function toBlocks(content: Anthropic.MessageParam["content"]): Anthropic.ContentBlockParam[] {
  if (typeof content === "string") return [{ type: "text", text: content }];
  return content as Anthropic.ContentBlockParam[];
}

/** Anthropic requires alternating roles — merge any consecutive same-role messages. */
function mergeConsecutive(msgs: Anthropic.MessageParam[]): Anthropic.MessageParam[] {
  const out: Anthropic.MessageParam[] = [];
  for (const m of msgs) {
    const last = out[out.length - 1];
    if (last && last.role === m.role) {
      last.content = [...toBlocks(last.content), ...toBlocks(m.content)];
    } else {
      out.push({ role: m.role, content: m.content });
    }
  }
  return out;
}

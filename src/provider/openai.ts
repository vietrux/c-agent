import OpenAI from "openai";
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

/** OpenAI-compatible provider. Works with OpenAI, NVIDIA NIM, vLLM, etc. */
export class OpenAIProvider implements Provider {
  readonly kind = "openai" as const;
  private client: OpenAI;
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
    this.client = new OpenAI({ apiKey: opts.apiKey, baseURL: opts.baseURL, maxRetries: 0 });
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
    return ids.sort();
  }

  private toWire(
    system: string,
    messages: NeutralMessage[],
  ): OpenAI.Chat.ChatCompletionMessageParam[] {
    const out: OpenAI.Chat.ChatCompletionMessageParam[] = [
      { role: "system", content: system },
    ];
    for (const m of messages) {
      if (m.role === "note") {
        out.push({ role: "system", content: m.content });
      } else if (m.role === "user") {
        out.push({ role: "user", content: m.content });
      } else if (m.role === "assistant") {
        // An assistant turn with neither text nor tool calls is invalid wire
        // (the API requires content or tool_calls); skip it so a transcript
        // left malformed by an interrupted turn can still be re-sent.
        if (!m.content && m.toolCalls.length === 0) continue;
        const msg: OpenAI.Chat.ChatCompletionAssistantMessageParam = {
          role: "assistant",
          content: m.content || null,
        };
        if (m.toolCalls.length > 0) {
          msg.tool_calls = m.toolCalls.map((tc) => ({
            id: tc.id,
            type: "function",
            function: { name: tc.name, arguments: JSON.stringify(tc.input ?? {}) },
          }));
        }
        out.push(msg);
      } else {
        for (const r of m.results) {
          out.push({ role: "tool", tool_call_id: r.id, content: r.content });
        }
      }
    }
    return out;
  }

  async stream(
    system: string,
    messages: NeutralMessage[],
    tools: ToolSpec[],
    handlers: StreamHandlers,
    signal?: AbortSignal,
  ): Promise<StreamResult> {
    const payload = applyRequestParams(
      {
        model: this.model,
        messages: this.toWire(system, messages),
        tools: tools.map((t) => ({
          type: "function" as const,
          function: { name: t.name, description: t.description, parameters: t.parameters },
        })),
        tool_choice: "auto",
        max_tokens: 8192,
        stream: true,
        stream_options: { include_usage: true },
      },
      this.getRequestParams(),
      ["model", "messages", "tools", "stream", "stream_options"],
    );
    const stream = (await this.client.chat.completions.create(payload as any, {
      signal,
    })) as unknown as AsyncIterable<any>;

    const usage: Usage = { input: 0, output: 0, cached: 0 };
    let text = "";
    // Accumulate streamed tool-call fragments by index. Each call is emitted as
    // soon as it is provably complete (a higher index has begun streaming, so
    // this one is finished) — this lets the scheduler start concurrency-safe
    // calls while the model is still producing the rest, matching the Anthropic
    // path. The last call is flushed at stream end. Ids are synthesized when the
    // provider omits them (some OpenAI-compatible servers do), so calls can't
    // collide on an empty id and tool_use/tool_result pairing stays intact.
    interface Acc {
      id: string;
      name: string;
      args: string;
      emitted: boolean;
      input?: any;
    }
    const acc = new Map<number, Acc>();
    let maxIndex = -1;

    // Emit the call at `idx` iff its arguments now parse as complete JSON.
    const settle = (idx: number): void => {
      const cur = acc.get(idx);
      if (!cur || cur.emitted) return;
      const parsed = tryParseArgs(cur.args);
      if (parsed === undefined) return; // arguments not finished streaming
      cur.id = cur.id || `call_${idx}`;
      cur.input = parsed;
      cur.emitted = true;
      handlers.onToolCallReady?.({ id: cur.id, name: cur.name, input: parsed });
    };

    for await (const chunk of stream) {
      if (chunk.usage) {
        usage.input = chunk.usage.prompt_tokens ?? 0;
        usage.output = chunk.usage.completion_tokens ?? 0;
        usage.cached = (chunk.usage as any).prompt_tokens_details?.cached_tokens ?? 0;
      }
      const delta = chunk.choices[0]?.delta;
      if (!delta) continue;
      const reasoning = ((delta as any).reasoning_content ?? (delta as any).reasoning) as
        | string
        | undefined;
      if (reasoning) handlers.onReasoning?.(reasoning);
      if (delta.content) {
        text += delta.content;
        handlers.onText(delta.content);
      }
      if (delta.tool_calls) {
        for (const tc of delta.tool_calls) {
          const idx = tc.index;
          const cur = acc.get(idx) ?? { id: "", name: "", args: "", emitted: false };
          if (tc.id) cur.id = tc.id;
          if (tc.function?.name) cur.name = tc.function.name;
          if (tc.function?.arguments) cur.args += tc.function.arguments;
          acc.set(idx, cur);
          if (idx > maxIndex) maxIndex = idx;
        }
        // Any index below the highest seen is finished — try to emit it early.
        for (const idx of acc.keys()) if (idx < maxIndex) settle(idx);
      }
    }

    // Flush in index order: emit anything not settled mid-stream (always at
    // least the final call), with synthesized ids and a last-resort parse.
    const toolCalls: ToolCall[] = [];
    for (const idx of [...acc.keys()].sort((a, b) => a - b)) {
      const cur = acc.get(idx)!;
      cur.id = cur.id || `call_${idx}`;
      if (!cur.emitted) {
        cur.input = tryParseArgs(cur.args) ?? safeParse(cur.args);
        cur.emitted = true;
        handlers.onToolCallReady?.({ id: cur.id, name: cur.name, input: cur.input });
      }
      toolCalls.push({ id: cur.id, name: cur.name, input: cur.input });
    }
    return { text, toolCalls, usage };
  }
}

/** Parse complete streamed arguments; undefined while still incomplete. */
function tryParseArgs(s: string): any | undefined {
  const t = s.trim();
  if (!t) return {}; // no arguments streamed → empty object
  try {
    return JSON.parse(t);
  } catch {
    return undefined;
  }
}

function safeParse(s: string): any {
  if (!s) return {};
  try {
    return JSON.parse(s);
  } catch {
    return { _raw: s };
  }
}

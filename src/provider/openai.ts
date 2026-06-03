import OpenAI from "openai";
import type {
  Provider,
  NeutralMessage,
  ToolSpec,
  StreamHandlers,
  StreamResult,
  ToolCall,
  Usage,
} from "./types.js";

/** OpenAI-compatible provider. Works with OpenAI, NVIDIA NIM, vLLM, etc. */
export class OpenAIProvider implements Provider {
  private client: OpenAI;
  model: string;

  constructor(opts: { apiKey: string; baseURL?: string; model: string }) {
    this.client = new OpenAI({ apiKey: opts.apiKey, baseURL: opts.baseURL });
    this.model = opts.model;
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
    const stream = await this.client.chat.completions.create(
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
      { signal },
    );

    const usage: Usage = { input: 0, output: 0, cached: 0 };
    let text = "";
    // accumulate tool calls by streamed index
    const acc = new Map<number, { id: string; name: string; args: string }>();

    for await (const chunk of stream) {
      if (chunk.usage) {
        usage.input = chunk.usage.prompt_tokens ?? 0;
        usage.output = chunk.usage.completion_tokens ?? 0;
        usage.cached = (chunk.usage as any).prompt_tokens_details?.cached_tokens ?? 0;
      }
      const delta = chunk.choices[0]?.delta;
      if (!delta) continue;
      const reasoning = (delta as any).reasoning_content as string | undefined;
      if (reasoning) handlers.onReasoning?.(reasoning);
      if (delta.content) {
        text += delta.content;
        handlers.onText(delta.content);
      }
      if (delta.tool_calls) {
        for (const tc of delta.tool_calls) {
          const idx = tc.index;
          const cur = acc.get(idx) ?? { id: "", name: "", args: "" };
          if (tc.id) cur.id = tc.id;
          if (tc.function?.name) cur.name = tc.function.name;
          if (tc.function?.arguments) cur.args += tc.function.arguments;
          acc.set(idx, cur);
        }
      }
    }

    const toolCalls: ToolCall[] = [...acc.values()].map((c) => ({
      id: c.id,
      name: c.name,
      input: safeParse(c.args),
    }));
    return { text, toolCalls, usage };
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

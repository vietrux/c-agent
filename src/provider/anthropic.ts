import Anthropic from "@anthropic-ai/sdk";
import type {
  Provider,
  NeutralMessage,
  ToolSpec,
  StreamHandlers,
  StreamResult,
  ToolCall,
  Usage,
} from "./types.js";

export class AnthropicProvider implements Provider {
  private client: Anthropic;
  model: string;

  constructor(opts: { apiKey: string; baseURL?: string; model: string }) {
    // SDK retries transient failures (429/5xx/overloaded) with exponential
    // backoff and honors Retry-After; bumped above the default 2.
    this.client = new Anthropic({ apiKey: opts.apiKey, baseURL: opts.baseURL, maxRetries: 5 });
    this.model = opts.model;
  }

  async listModels(): Promise<string[]> {
    const ids: string[] = [];
    for await (const m of this.client.models.list()) ids.push(m.id);
    return ids;
  }

  private toWire(messages: NeutralMessage[]): Anthropic.MessageParam[] {
    const mapped = messages.map((m): Anthropic.MessageParam => {
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
    const stream = this.client.messages.stream(
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
      { signal },
    );
    stream.on("text", (d) => handlers.onText(d));

    const final = await stream.finalMessage();
    let text = "";
    const toolCalls: ToolCall[] = [];
    for (const block of final.content) {
      if (block.type === "text") text += block.text;
      else if (block.type === "tool_use") {
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

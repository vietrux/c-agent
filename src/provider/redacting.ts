import type {
  Provider,
  NeutralMessage,
  ToolSpec,
  StreamHandlers,
  StreamResult,
} from "./types.js";
import {
  StreamRestorer,
  deepRedact,
  deepRestore,
  undercoverSystem,
  type UndercoverState,
} from "../utils/redact.js";

/**
 * Wraps a provider with undercover (PII-masking) behavior. When enabled, every
 * outbound message is redacted to tokens before reaching the model and every
 * inbound stream/result is restored to real values. When disabled it is a
 * transparent pass-through. The session, UI, and tools always see real data —
 * only the wire to the model is masked.
 */
export class RedactingProvider implements Provider {
  constructor(
    private inner: Provider,
    private state: UndercoverState,
  ) {}

  get model(): string {
    return this.inner.model;
  }

  set model(m: string) {
    this.inner.model = m;
  }

  /** Swap the backing provider (used to switch between configured providers). */
  setInner(p: Provider) {
    this.inner = p;
  }

  listModels(): Promise<string[]> {
    return this.inner.listModels ? this.inner.listModels() : Promise.resolve([]);
  }

  async stream(
    system: string,
    messages: NeutralMessage[],
    tools: ToolSpec[],
    handlers: StreamHandlers,
    signal?: AbortSignal,
  ): Promise<StreamResult> {
    if (!this.state.enabled) {
      return this.inner.stream(system, messages, tools, handlers, signal);
    }
    const vault = this.state.vault;

    const sys = system + undercoverSystem(vault.sessId);
    const redacted = messages.map((m) => this.redactMessage(m));

    const textRestorer = new StreamRestorer(vault);
    const reasoningRestorer = new StreamRestorer(vault);
    const wrapped: StreamHandlers = {
      onText: (d) => {
        const out = textRestorer.push(d);
        if (out) handlers.onText(out);
      },
      onReasoning: handlers.onReasoning
        ? (d) => {
            const out = reasoningRestorer.push(d);
            if (out) handlers.onReasoning!(out);
          }
        : undefined,
      onToolCallReady: handlers.onToolCallReady
        ? (tc) =>
            handlers.onToolCallReady!({
              ...tc,
              input: deepRestore(tc.input, vault),
            })
        : undefined,
    };

    const res = await this.inner.stream(sys, redacted, tools, wrapped, signal);

    const tailText = textRestorer.flush();
    if (tailText) handlers.onText(tailText);
    if (handlers.onReasoning) {
      const tailReason = reasoningRestorer.flush();
      if (tailReason) handlers.onReasoning(tailReason);
    }

    return {
      text: vault.restore(res.text),
      toolCalls: res.toolCalls.map((tc) => ({ ...tc, input: deepRestore(tc.input, vault) })),
      usage: res.usage,
    };
  }

  private redactMessage(m: NeutralMessage): NeutralMessage {
    const vault = this.state.vault;
    if (m.role === "note") return { role: "note", content: vault.redact(m.content) };
    if (m.role === "user") return { role: "user", content: vault.redact(m.content) };
    if (m.role === "assistant") {
      return {
        role: "assistant",
        content: vault.redact(m.content),
        toolCalls: m.toolCalls.map((tc) => ({ ...tc, input: deepRedact(tc.input, vault) })),
      };
    }
    return {
      role: "tool",
      results: m.results.map((r) => ({ ...r, content: vault.redact(r.content) })),
    };
  }
}

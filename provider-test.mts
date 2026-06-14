import { strict as assert } from "node:assert";
import { resolveProvider } from "./src/provider/index.js";
import {
  buildModelItems,
  type ProviderListState,
} from "./src/tui/model-picker.js";
import {
  configuredModelIds,
  configuredModelParams,
  type ProviderConfig,
} from "./src/settings.js";
import type { NeutralMessage, Provider, StreamResult } from "./src/provider/types.js";

let passed = 0;
let failed = 0;

async function test(name: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (err: any) {
    console.log(`  ✗ ${name}: ${err?.message ?? String(err)}`);
    failed++;
  }
}

console.log("\nprovider config");

function emptyOpenAIStream(reasoning?: string) {
  return {
    async *[Symbol.asyncIterator]() {
      if (reasoning) yield { choices: [{ delta: { reasoning } }] };
      yield {
        choices: [{ delta: { content: "ok" } }],
        usage: { prompt_tokens: 3, completion_tokens: 1 },
      };
    },
  };
}

function anthropicStream(finalText = "ok", thinking?: string) {
  const listeners: Record<string, (...args: any[]) => void> = {};
  return {
    on(event: string, fn: (...args: any[]) => void) {
      listeners[event] = fn;
    },
    async finalMessage() {
      if (thinking) listeners.thinking?.(thinking, thinking);
      return {
        content: thinking
          ? [{ type: "thinking", thinking }, { type: "text", text: finalText }]
          : [{ type: "text", text: finalText }],
        usage: {
          input_tokens: 3,
          output_tokens: 1,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
        },
      };
    },
  };
}

async function runOneTurn(
  provider: Provider,
  onReasoning?: (delta: string) => void,
): Promise<StreamResult> {
  const messages: NeutralMessage[] = [{ role: "user", content: "hi" }];
  return provider.stream("system", messages, [], { onText() {}, onReasoning });
}

await test("allows explicit no-auth custom provider to keep configured model", () => {
  const { provider } = resolveProvider({
    type: "anthropic",
    baseURL: "http://localhost:11434",
    apiKey: "",
    model: "minimax-m3:cloud",
  });
  assert.equal(provider.model, "minimax-m3:cloud");
});

await test("configured model is searchable while remote list is still pending", () => {
  const { provider } = resolveProvider({
    type: "anthropic",
    baseURL: "http://localhost:11434",
    apiKey: "",
    model: "minimax-m3:cloud",
  });
  const states: ProviderListState[] = [
    {
      entry: { name: "ollama", provider, configuredModels: ["minimax-m3:cloud"] },
      remoteModels: [],
      status: "pending",
    },
  ];
  const built = buildModelItems(states);
  assert.deepEqual(built.items.map((item) => item.label), ["minimax-m3:cloud (Ollama)"]);
  assert.equal(
    built.items.some((item) => item.label.toLowerCase().includes("minimax-m3:cloud")),
    true,
  );
});

await test("remote models append without duplicating configured models", () => {
  const { provider } = resolveProvider({
    type: "openai",
    baseURL: "https://example.invalid/v1",
    apiKey: "test",
    model: "configured-model",
    models: ["extra-model"],
  });
  const built = buildModelItems([
    {
      entry: { name: "test", provider, configuredModels: ["configured-model", "extra-model"] },
      remoteModels: ["configured-model", "remote-model"],
      status: "done",
    },
  ]);
  assert.deepEqual(built.items.map((item) => item.label), [
    "configured-model (TEST)",
    "extra-model (TEST)",
    "remote-model (TEST)",
  ]);
});

await test("collects model ids and params from keyed and inline model config", () => {
  const cfg: ProviderConfig = {
    type: "openai",
    apiKey: "test",
    model: { id: "active-model", params: { temperature: 0.1 } },
    models: [
      "plain-model",
      { id: "reasoning-model", params: { reasoning: { effort: "high" } } },
      { id: "active-model", params: { top_p: 0.9 } },
    ],
    modelParams: {
      "active-model": { presence_penalty: 0.2 },
      "reasoning-model": { temperature: 0.3 },
      "params-only-model": { temperature: 0.5 },
    },
  };
  assert.deepEqual(configuredModelIds(cfg), [
    "active-model",
    "plain-model",
    "reasoning-model",
    "params-only-model",
  ]);
  assert.deepEqual(configuredModelParams(cfg), {
    "active-model": { presence_penalty: 0.2, temperature: 0.1, top_p: 0.9 },
    "reasoning-model": { temperature: 0.3, reasoning: { effort: "high" } },
    "params-only-model": { temperature: 0.5 },
  });
});

await test("selected model changes active request params", () => {
  const { provider } = resolveProvider({
    type: "openai",
    apiKey: "test",
    model: "fast-model",
    params: { temperature: 0.2, top_p: 0.95 },
    models: [
      { id: "fast-model", params: { frequency_penalty: 0.1 } },
      { id: "deep-model", params: { temperature: 0.7, reasoning_effort: "high" } },
    ],
  });
  assert.deepEqual(provider.getRequestParams?.(), {
    temperature: 0.2,
    top_p: 0.95,
    frequency_penalty: 0.1,
  });
  provider.model = "deep-model";
  assert.deepEqual(provider.getRequestParams?.(), {
    temperature: 0.7,
    top_p: 0.95,
    reasoning_effort: "high",
  });
});

await test("openai-compatible stream payload includes selected model params", async () => {
  const { provider } = resolveProvider({
    type: "openai",
    apiKey: "test",
    model: "deep-model",
    params: { temperature: 0.2, messages: "blocked" },
    modelParams: {
      "deep-model": {
        reasoning_effort: "high",
        reasoning: { effort: "high" },
        presence_penalty: 0.4,
        frequency_penalty: 0.1,
        stream: false,
      },
    },
  });
  let captured: any;
  (provider as any).client = {
    chat: {
      completions: {
        create: async (payload: any) => {
          captured = payload;
          return emptyOpenAIStream();
        },
      },
    },
  };

  const result = await runOneTurn(provider);
  assert.equal(result.text, "ok");
  assert.equal(captured.model, "deep-model");
  assert.equal(captured.temperature, 0.2);
  assert.equal(captured.reasoning_effort, "high");
  assert.deepEqual(captured.reasoning, { effort: "high" });
  assert.equal(captured.presence_penalty, 0.4);
  assert.equal(captured.frequency_penalty, 0.1);
  assert.equal(captured.stream, true);
  assert.notEqual(captured.messages, "blocked");
});

await test("openai-compatible stream forwards Ollama delta.reasoning", async () => {
  const { provider } = resolveProvider({
    type: "openai",
    apiKey: "test",
    model: "ollama-model",
  });
  (provider as any).client = {
    chat: {
      completions: {
        create: async () => emptyOpenAIStream("ollama reasoning"),
      },
    },
  };

  let reasoning = "";
  const result = await runOneTurn(provider, (delta) => {
    reasoning += delta;
  });
  assert.equal(result.text, "ok");
  assert.equal(reasoning, "ollama reasoning");
});

await test("anthropic stream payload includes selected model params", async () => {
  const { provider } = resolveProvider({
    type: "anthropic",
    apiKey: "test",
    model: "claude-model",
    params: { temperature: 0.1, model: "blocked" },
    modelParams: {
      "claude-model": {
        max_tokens: 2048,
        top_p: 0.8,
        top_k: 40,
        thinking: { type: "enabled", budget_tokens: 1024 },
      },
    },
  });
  let captured: any;
  (provider as any).client = {
    messages: {
      stream: (payload: any) => {
        captured = payload;
        return anthropicStream();
      },
    },
  };

  const result = await runOneTurn(provider);
  assert.equal(result.text, "ok");
  assert.equal(captured.model, "claude-model");
  assert.equal(captured.temperature, 0.1);
  assert.equal(captured.max_tokens, 2048);
  assert.equal(captured.top_p, 0.8);
  assert.equal(captured.top_k, 40);
  assert.deepEqual(captured.thinking, { type: "enabled", budget_tokens: 1024 });
});

await test("anthropic-compatible stream forwards thinking deltas", async () => {
  const { provider } = resolveProvider({
    type: "anthropic",
    apiKey: "test",
    model: "ollama-model",
  });
  (provider as any).client = {
    messages: {
      stream: () => anthropicStream("ok", "anthropic thinking"),
    },
  };

  let reasoning = "";
  const result = await runOneTurn(provider, (delta) => {
    reasoning += delta;
  });
  assert.equal(result.text, "ok");
  assert.equal(reasoning, "anthropic thinking");
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);

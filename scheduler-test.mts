import { strict as assert } from "node:assert";
import { setTimeout as sleep } from "node:timers/promises";
import { ProcessManager } from "./src/process/manager.js";
import type { Tool } from "./src/tools/registry.js";
import { ToolRegistry, type ToolContext } from "./src/tools/registry.js";
import {
  runScheduledTools,
  StreamingToolScheduler,
  type ToolEventInfo,
} from "./src/tools/scheduler.js";
import type { ToolCall } from "./src/provider/types.js";

type Event =
  | { type: "queued"; id: string; info: ToolEventInfo }
  | { type: "start"; id: string; info: ToolEventInfo }
  | { type: "end"; id: string; info: ToolEventInfo; isError: boolean };

const pm = new ProcessManager();
const ctx: ToolContext = { pm, cwd: process.cwd(), todos: [] };

let passed = 0;
let failed = 0;

function tool(
  name: string,
  concurrencySafe: boolean,
  run: Tool["run"],
): Tool {
  return {
    concurrencySafe,
    spec: {
      name,
      description: `${name} test tool`,
      parameters: { type: "object", properties: {} },
    },
    run,
  };
}

function events(log: Event[]) {
  return {
    toolQueued(id: string, _name: string, _input: any, info: ToolEventInfo) {
      log.push({ type: "queued", id, info });
    },
    toolStart(id: string, _name: string, _input: any, info: ToolEventInfo) {
      log.push({ type: "start", id, info });
    },
    toolEnd(
      id: string,
      _result: string,
      isError: boolean,
      info: ToolEventInfo,
    ) {
      log.push({ type: "end", id, info, isError });
    },
  };
}

async function test(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (err: any) {
    console.log(`  ✗ ${name}: ${err?.message ?? String(err)}`);
    failed++;
  }
}

function calls(...items: [string, string, any?][]): ToolCall[] {
  return items.map(([id, name, input]) => ({ id, name, input: input ?? {} }));
}

console.log("\nscheduler");

await test("preserves result order for parallel safe tools", async () => {
  const registry = new ToolRegistry();
  registry.register(
    tool("safe", true, async (input) => {
      await sleep(Number(input.delay));
      return { text: String(input.value) };
    }),
  );
  const log: Event[] = [];
  const result = await runScheduledTools(
    calls(["a", "safe", { delay: 30, value: "first" }], ["b", "safe", { delay: 1, value: "second" }]),
    registry,
    ctx,
    events(log),
    undefined,
    { maxConcurrency: 2 },
  );
  assert.deepEqual(result.map((r) => r.content), ["first", "second"]);
  assert.equal(log.filter((e) => e.type === "queued").length, 2);
  assert.equal(log.filter((e) => e.type === "start").length, 2);
  assert.equal(log.filter((e) => e.type === "end").length, 2);
});

await test("enforces unsafe tools as serial barriers", async () => {
  const registry = new ToolRegistry();
  let safeCompleted = 0;
  let unsafeCompleted = false;
  registry.register(
    tool("safe", true, async (input) => {
      if (input.afterUnsafe) assert.equal(unsafeCompleted, true);
      await sleep(10);
      safeCompleted++;
      return { text: String(input.value) };
    }),
  );
  registry.register(
    tool("unsafe", false, async () => {
      assert.equal(safeCompleted, 2);
      await sleep(5);
      unsafeCompleted = true;
      return { text: "mutated" };
    }),
  );
  const result = await runScheduledTools(
    calls(
      ["s1", "safe", { value: "one" }],
      ["s2", "safe", { value: "two" }],
      ["m1", "unsafe"],
      ["s3", "safe", { value: "three", afterUnsafe: true }],
    ),
    registry,
    ctx,
    events([]),
    undefined,
    { maxConcurrency: 4 },
  );
  assert.deepEqual(result.map((r) => r.content), ["one", "two", "mutated", "three"]);
});

await test("respects max concurrency for safe batches", async () => {
  const registry = new ToolRegistry();
  let active = 0;
  let maxActive = 0;
  registry.register(
    tool("safe", true, async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      await sleep(15);
      active--;
      return { text: "ok" };
    }),
  );
  await runScheduledTools(
    calls(["a", "safe"], ["b", "safe"], ["c", "safe"], ["d", "safe"]),
    registry,
    ctx,
    events([]),
    undefined,
    { maxConcurrency: 2 },
  );
  assert.equal(maxActive, 2);
});

await test("converts thrown tool errors into ordered error results", async () => {
  const registry = new ToolRegistry();
  registry.register(tool("boom", true, async () => {
    throw new Error("explode");
  }));
  registry.register(tool("safe", true, async () => ({ text: "after" })));
  const result = await runScheduledTools(
    calls(["a", "boom"], ["b", "safe"]),
    registry,
    ctx,
    events([]),
    undefined,
    { maxConcurrency: 2 },
  );
  assert.equal(result[0].isError, true);
  assert.match(result[0].content, /explode/);
  assert.equal(result[1].content, "after");
});

await test("returns interrupted results when aborted before execution", async () => {
  const registry = new ToolRegistry();
  registry.register(tool("safe", true, async () => ({ text: "should not run" })));
  const ac = new AbortController();
  ac.abort();
  const log: Event[] = [];
  const result = await runScheduledTools(
    calls(["a", "safe"], ["b", "safe"]),
    registry,
    ctx,
    events(log),
    ac.signal,
    { maxConcurrency: 2 },
  );
  assert.deepEqual(result.map((r) => r.content), ["✗ interrupted", "✗ interrupted"]);
  assert.equal(log.filter((e) => e.type === "end" && e.isError).length, 2);
});

await test("streaming scheduler starts safe tools before releasing unsafe barrier", async () => {
  const registry = new ToolRegistry();
  registry.register(tool("safe", true, async () => ({ text: "safe" })));
  registry.register(tool("unsafe", false, async () => ({ text: "unsafe" })));
  const log: Event[] = [];
  const scheduler = new StreamingToolScheduler(
    registry,
    ctx,
    events(log),
    undefined,
    { maxConcurrency: 2, deferUnsafeUntilReleased: true },
  );

  scheduler.add({ id: "s1", name: "safe", input: {} });
  scheduler.add({ id: "m1", name: "unsafe", input: {} });
  scheduler.add({ id: "s2", name: "safe", input: {} });
  await sleep(5);

  assert.equal(log.some((e) => e.type === "start" && e.id === "s1"), true);
  assert.equal(log.some((e) => e.type === "start" && e.id === "m1"), false);
  assert.equal(log.some((e) => e.type === "start" && e.id === "s2"), false);

  scheduler.releaseUnsafe();
  const result = await scheduler.waitFor(
    calls(["s1", "safe"], ["m1", "unsafe"], ["s2", "safe"]),
  );
  assert.deepEqual(result.map((r) => r.content), ["safe", "unsafe", "safe"]);
  assert.equal(log.some((e) => e.type === "start" && e.id === "m1"), true);
  assert.equal(log.some((e) => e.type === "start" && e.id === "s2"), true);
});

pm.killAll();
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);

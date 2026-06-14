import { strict as assert } from "node:assert";
import { buildRegistry } from "./src/tools/index.js";
import { skillTool } from "./src/tools/skill.js";
import type { ToolContext } from "./src/tools/registry.js";
import { ProcessManager } from "./src/process/manager.js";

const pm = new ProcessManager();
const ctx: ToolContext = {
  pm,
  cwd: process.cwd(),
  todos: [],
};

let passed = 0;
let failed = 0;

async function test(name: string, fn: () => Promise<void> | void) {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (err: any) {
    console.log(`  ✗ ${name}: ${err?.message ?? String(err)}`);
    failed++;
  }
}

console.log("\ntool_search");

await test("default specs hide deferred tools and include tool_search", () => {
  const registry = buildRegistry();
  const names = registry.specs().map((s) => s.name);
  assert.equal(names.includes("tool_search"), true);
  assert.equal(names.includes("read"), true);
  assert.equal(names.includes("web_fetch"), false);
  assert.equal(names.includes("encode_decode"), false);
  assert.equal(names.includes("notes"), false);
});

await test("tool_search finds deferred tools by keyword", async () => {
  const registry = buildRegistry();
  const search = registry.specs().find((s) => s.name === "tool_search");
  assert.ok(search);
  const tool = registry.searchDeferred("base64", 3);
  assert.equal(tool[0]?.spec.name, "encode_decode");
});

await test("select activates a deferred tool for subsequent specs", async () => {
  const registry = buildRegistry();
  const result = await registry.dispatch(
    "tool_search",
    { query: "select:web_fetch" },
    ctx,
  );
  assert.equal(result.isError, undefined);
  assert.match(result.text, /activated web_fetch/);
  assert.equal(registry.specs().some((s) => s.name === "web_fetch"), true);
});

await test("skill tool is directly available, not hidden behind tool_search", async () => {
  const registry = buildRegistry();
  registry.register(skillTool);
  // The system prompt advertises `skill`, so it must be in the default schema
  // (no activate-first dance) whenever skills are registered.
  assert.equal(registry.specs().some((s) => s.name === "skill"), true);
  assert.equal(registry.searchDeferred("skill workflow", 3).length, 0);
});

pm.killAll();
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);

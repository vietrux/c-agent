import { strict as assert } from "node:assert";
import { ProcessManager } from "./src/process/manager.js";
import { skillTool } from "./src/tools/skill.js";
import { ToolRegistry, type ToolContext } from "./src/tools/registry.js";

const pm = new ProcessManager();
const ctx: ToolContext = {
  pm,
  cwd: process.cwd(),
  todos: [],
  skills: [
    { name: "alpha", description: "Alpha workflow", body: "Alpha body" },
    { name: "beta", description: "Beta workflow", body: "Beta body" },
    { name: "gamma", description: "Gamma workflow", body: "Gamma body" },
  ],
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

function registry(): ToolRegistry {
  const r = new ToolRegistry();
  r.register(skillTool);
  return r;
}

console.log("\nskill");

await test("loads one skill with legacy name parameter", async () => {
  const result = await registry().dispatch("skill", { name: "alpha" }, ctx);
  assert.equal(result.isError, undefined);
  assert.match(result.text, /^# Skill: alpha/);
  assert.match(result.text, /Alpha body/);
});

await test("loads multiple skills in one composed result", async () => {
  const result = await registry().dispatch(
    "skill",
    { names: ["alpha", "beta"] },
    ctx,
  );
  assert.equal(result.isError, undefined);
  assert.match(result.text, /^# Skills loaded: alpha, beta/);
  assert.match(result.text, /<skill name="alpha">\nAlpha body\n<\/skill>/);
  assert.match(result.text, /<skill name="beta">\nBeta body\n<\/skill>/);
  assert.ok(result.text.indexOf("Alpha body") < result.text.indexOf("Beta body"));
});

await test("merges name and names while preserving first occurrence order", async () => {
  const result = await registry().dispatch(
    "skill",
    { name: "beta", names: ["alpha", "beta", "/gamma"] },
    ctx,
  );
  assert.equal(result.isError, undefined);
  assert.match(result.text, /^# Skills loaded: beta, alpha, gamma/);
  assert.equal((result.text.match(/<skill name="beta">/g) ?? []).length, 1);
});

await test("rejects missing skill names", async () => {
  const result = await registry().dispatch("skill", {}, ctx);
  assert.equal(result.isError, true);
  assert.match(result.text, /missing skill name/);
  assert.match(result.text, /available: alpha, beta, gamma/);
});

await test("rejects unknown skills without partially loading", async () => {
  const result = await registry().dispatch(
    "skill",
    { names: ["alpha", "missing"] },
    ctx,
  );
  assert.equal(result.isError, true);
  assert.match(result.text, /unknown skill: missing/);
  assert.doesNotMatch(result.text, /Alpha body/);
});

await test("rejects non-string array entries", async () => {
  const result = await registry().dispatch(
    "skill",
    { names: ["alpha", 42] },
    ctx,
  );
  assert.equal(result.isError, true);
  assert.match(result.text, /names\[\] must be string/);
});

pm.killAll();
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);

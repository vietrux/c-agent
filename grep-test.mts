import { strict as assert } from "node:assert";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProcessManager } from "./src/process/manager.js";
import type { ToolContext } from "./src/tools/registry.js";
import { grepTool } from "./src/tools/files.js";

const root = await mkdtemp(join(tmpdir(), "c-agent-grep-"));
await mkdir(join(root, "src"), { recursive: true });
await writeFile(join(root, "src", "a.ts"), "alpha\nbeta\nalpha two\n", "utf8");
await writeFile(join(root, "src", "b.js"), "gamma\nalpha js\n", "utf8");
await writeFile(join(root, "README.md"), "alpha docs\n", "utf8");

const pm = new ProcessManager();
const ctx: ToolContext = { pm, cwd: root, todos: [] };

let passed = 0;
let failed = 0;

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

console.log("\ngrep");

await test("content mode returns matching lines with pagination", async () => {
  const result = await grepTool.run(
    { pattern: "alpha", path: root, output_mode: "content", head_limit: 2 },
    ctx,
  );
  assert.equal(result.isError, undefined);
  const lines = result.text.split("\n");
  assert.ok(lines.length >= 3);
  assert.match(result.text, /more/);
});

await test("files_with_matches mode returns matching filenames", async () => {
  const result = await grepTool.run(
    { pattern: "alpha", path: root, output_mode: "files_with_matches" },
    ctx,
  );
  assert.equal(result.isError, undefined);
  assert.match(result.text, /a\.ts|README\.md|b\.js/);
});

await test("count mode returns counts", async () => {
  const result = await grepTool.run(
    { pattern: "alpha", path: root, output_mode: "count" },
    ctx,
  );
  assert.equal(result.isError, undefined);
  assert.match(result.text, /[0-9]/);
});

pm.killAll();
await rm(root, { recursive: true, force: true });

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);

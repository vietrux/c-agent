import { strict as assert } from "node:assert";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProcessManager } from "./src/process/manager.js";
import type { ToolContext } from "./src/tools/registry.js";
import {
  editTool,
  multiEditTool,
  readTool,
  writeTool,
} from "./src/tools/files.js";

const root = await mkdtemp(join(tmpdir(), "c-agent-file-safety-"));
const pm = new ProcessManager();
const ctx: ToolContext = {
  pm,
  cwd: root,
  todos: [],
  fileReads: new Map(),
};

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

console.log("\nfile safety");

await test("edit rejects existing file that was not read", async () => {
  const path = join(root, "unread.txt");
  await writeFile(path, "alpha\n", "utf8");
  const result = await editTool.run(
    { path, old_string: "alpha", new_string: "beta" },
    ctx,
  );
  assert.equal(result.isError, true);
  assert.match(result.text, /must read/);
});

await test("read then edit succeeds and refreshes snapshot", async () => {
  const path = join(root, "edit.txt");
  await writeFile(path, "one\ntwo\n", "utf8");
  await readTool.run({ path }, ctx);
  const result = await editTool.run(
    { path, old_string: "two", new_string: "three" },
    ctx,
  );
  assert.equal(result.isError, undefined);
  assert.equal(await readFile(path, "utf8"), "one\nthree\n");

  const second = await editTool.run(
    { path, old_string: "three", new_string: "four" },
    ctx,
  );
  assert.equal(second.isError, undefined);
  assert.equal(await readFile(path, "utf8"), "one\nfour\n");
});

await test("edit rejects stale file after external change", async () => {
  const path = join(root, "stale-edit.txt");
  await writeFile(path, "before\n", "utf8");
  await readTool.run({ path }, ctx);
  await writeFile(path, "changed elsewhere\n", "utf8");
  const result = await editTool.run(
    { path, old_string: "changed", new_string: "updated" },
    ctx,
  );
  assert.equal(result.isError, true);
  assert.match(result.text, /changed since/);
});

await test("write rejects existing unread file", async () => {
  const path = join(root, "unread-write.txt");
  await writeFile(path, "old\n", "utf8");
  const result = await writeTool.run({ path, content: "new\n" }, ctx);
  assert.equal(result.isError, true);
  assert.match(result.text, /must read/);
  assert.equal(await readFile(path, "utf8"), "old\n");
});

await test("write allows new file without prior read and refreshes snapshot", async () => {
  const path = join(root, "new-file.txt");
  const result = await writeTool.run({ path, content: "created\n" }, ctx);
  assert.equal(result.isError, undefined);
  assert.equal(await readFile(path, "utf8"), "created\n");

  const edit = await editTool.run(
    { path, old_string: "created", new_string: "updated" },
    ctx,
  );
  assert.equal(edit.isError, undefined);
  assert.equal(await readFile(path, "utf8"), "updated\n");
});

await test("multi_edit rejects stale file and preserves content", async () => {
  const path = join(root, "stale-multi.txt");
  await writeFile(path, "a b c\n", "utf8");
  await readTool.run({ path }, ctx);
  await writeFile(path, "external\n", "utf8");
  const result = await multiEditTool.run(
    {
      path,
      edits: [{ old_string: "external", new_string: "internal" }],
    },
    ctx,
  );
  assert.equal(result.isError, true);
  assert.match(result.text, /changed since/);
  assert.equal(await readFile(path, "utf8"), "external\n");
});

pm.killAll();
await rm(root, { recursive: true, force: true });

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);

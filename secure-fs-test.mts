import { strict as assert } from "node:assert";
import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeSecureFileAtomic } from "./src/utils/secure-fs.js";

const root = await mkdtemp(join(tmpdir(), "c-agent-secure-fs-"));
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

console.log("\nsecure fs");

await test("atomic secure write creates private file and replaces content", async () => {
  const file = join(root, "session.json");
  writeSecureFileAtomic(file, "one");
  writeSecureFileAtomic(file, "two");

  assert.equal(await readFile(file, "utf8"), "two");
  const mode = (await stat(file)).mode & 0o777;
  assert.equal(mode, 0o600);

  const leftovers = (await readdir(root)).filter((name) => name.includes(".tmp"));
  assert.deepEqual(leftovers, []);
});

await rm(root, { recursive: true, force: true });

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);

import { strict as assert } from "node:assert";
import { isReadOnlyBashCommand } from "./src/tools/bash-classifier.js";

let passed = 0;
let failed = 0;

function test(name: string, fn: () => void) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (err: any) {
    console.log(`  ✗ ${name}: ${err?.message ?? String(err)}`);
    failed++;
  }
}

console.log("\nbash classifier");

test("allows quoted metacharacters in read-only commands", () => {
  assert.equal(isReadOnlyBashCommand(`grep ">" file.txt`), true);
  assert.equal(isReadOnlyBashCommand(`rg 'foo|bar' src`), true);
  assert.equal(isReadOnlyBashCommand(`printf '%s\\n' hello`), true);
});

test("allows git -C with read-only subcommands", () => {
  assert.equal(isReadOnlyBashCommand("git -C repo status"), true);
  assert.equal(isReadOnlyBashCommand("git -C repo log --oneline"), true);
});

test("rejects redirects, pipes, chains, and substitutions", () => {
  assert.equal(isReadOnlyBashCommand("echo hi > file"), false);
  assert.equal(isReadOnlyBashCommand("cat a | grep x"), false);
  assert.equal(isReadOnlyBashCommand("ls; rm -rf x"), false);
  assert.equal(isReadOnlyBashCommand("grep $(whoami) file"), false);
  assert.equal(isReadOnlyBashCommand(`echo "$HOME"`), false);
});

test("rejects mutating git and find operations", () => {
  assert.equal(isReadOnlyBashCommand("git -C repo checkout main"), false);
  assert.equal(isReadOnlyBashCommand("git --git-dir=.git status"), false);
  assert.equal(isReadOnlyBashCommand("find . -exec ls {} \\;"), false);
  assert.equal(isReadOnlyBashCommand("find . -delete"), false);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);

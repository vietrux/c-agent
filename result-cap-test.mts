import { strict as assert } from "node:assert";
import { capToolResultsAggregate } from "./src/tools/result-cap.js";

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

console.log("\nresult cap");

test("leaves aggregate output unchanged when under budget", () => {
  const input = [
    { id: "a", content: "short", isError: false },
    { id: "b", content: "small", isError: false },
  ];
  assert.deepEqual(capToolResultsAggregate(input, 100), input);
});

test("reduces large aggregate output while preserving result order", () => {
  const input = [
    { id: "a", content: "a".repeat(5_000), isError: false },
    { id: "b", content: "b".repeat(5_000), isError: false },
    { id: "c", content: "c".repeat(5_000), isError: true },
  ];
  const output = capToolResultsAggregate(input, 2_000);
  assert.deepEqual(output.map((r) => r.id), ["a", "b", "c"]);
  assert.equal(output[2].isError, true);
  assert.ok(output.reduce((sum, r) => sum + r.content.length, 0) < 15_000);
  assert.match(output.map((r) => r.content).join("\n"), /aggregate result budget|output truncated/);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);

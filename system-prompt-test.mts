import { strict as assert } from "node:assert";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildSystemPrompt, knowledgeCutoff } from "./src/system-prompt.js";

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

// Minimal ProcessManager stand-in: maps a git command to its canned output.
function fakePm(map: Record<string, string>, missing: string[] = []) {
  return {
    run: async ({ command }: { command: string }) => {
      if (missing.includes(command)) return { exitCode: 1, output: "" };
      const hit = Object.keys(map).find((k) => command === k);
      return hit !== undefined
        ? { exitCode: 0, output: map[hit] }
        : { exitCode: 1, output: "" };
    },
  } as any;
}

const GIT_REPO = {
  "git rev-parse --is-inside-work-tree": "true",
  "git rev-parse --abbrev-ref HEAD": "feature/x",
  "git rev-parse --git-dir": ".git",
  "git --no-optional-locks status --short": " M src/foo.ts",
  "git --no-optional-locks log --oneline -n 5": "abc123 do a thing",
  "git config user.name": "Jane Dev",
  "git rev-parse --abbrev-ref origin/HEAD": "origin/main",
};

const tmp = () => mkdtempSync(join(tmpdir(), "cagent-sp-"));

const baseOpts = (over: any = {}) => ({
  base: "You are c-agent.",
  behavior: "Be helpful.",
  cwd: tmp(),
  model: "claude-opus-4-8",
  toolNames: ["bash", "read", "edit", "grep", "glob", "task", "todo", "tool_search"],
  pm: fakePm(GIT_REPO),
  ...over,
});

console.log("system-prompt");

await test("knowledgeCutoff maps known model families", () => {
  assert.equal(knowledgeCutoff("claude-opus-4-8"), "early 2025");
  assert.equal(knowledgeCutoff("gpt-4o-mini"), "October 2023");
  assert.equal(knowledgeCutoff("some-unknown-model"), null);
});

await test("main-agent prompt includes env, git status, tools, model", async () => {
  const p = await buildSystemPrompt(baseOpts());
  assert.match(p, /You are c-agent\./);
  assert.match(p, /<environment>/);
  assert.match(p, /Is a git repository: yes/);
  assert.match(p, /You are powered by the model claude-opus-4-8\./);
  assert.match(p, /Assistant knowledge cutoff is early 2025\./);
  // git-status snapshot block
  assert.match(p, /<git-status>/);
  assert.match(p, /Current branch: feature\/x/);
  assert.match(p, /Main branch \(you will usually use this for PRs\): main/);
  assert.match(p, /Git user: Jane Dev/);
  assert.match(p, /abc123 do a thing/);
  // tool-aware guidance
  assert.match(p, /# Using your tools/);
  assert.match(p, /`grep`/);
});

await test("git status is truncated past 2k chars", async () => {
  const big = "?? " + "a".repeat(3000);
  const p = await buildSystemPrompt(
    baseOpts({ pm: fakePm({ ...GIT_REPO, "git --no-optional-locks status --short": big }) }),
  );
  assert.match(p, /truncated/);
  assert.ok(!p.includes("a".repeat(2500)), "should not contain the full oversized status");
});

await test("non-git directory reports no repo and omits git-status block", async () => {
  const p = await buildSystemPrompt(
    baseOpts({ pm: fakePm({}, ["git rev-parse --is-inside-work-tree"]) }),
  );
  assert.match(p, /Is a git repository: no/);
  assert.ok(!p.includes("<git-status>"), "no git-status block for a non-repo");
});

await test("worktree is detected from the git-dir path", async () => {
  const p = await buildSystemPrompt(
    baseOpts({
      pm: fakePm({ ...GIT_REPO, "git rev-parse --git-dir": "/repo/.git/worktrees/wt1" }),
    }),
  );
  assert.match(p, /This is a git worktree/);
});

await test("subagent prompt gets role notes and no git probe", async () => {
  let called = false;
  const pm = { run: async () => { called = true; return { exitCode: 0, output: "" }; } } as any;
  const p = await buildSystemPrompt(baseOpts({ subagent: true, pm }));
  assert.equal(called, false, "subagent must not run git commands");
  assert.match(p, /# Operating as a subagent/);
  assert.ok(!p.includes("<git-status>"), "subagent omits the git-status block");
  assert.match(p, /<environment>/); // still gets env
});

await test("skills and MCP instructions are injected when present", async () => {
  const p = await buildSystemPrompt(
    baseOpts({
      skills: [{ name: "deploy", description: "ship the app" }],
      mcpInstructions: "## github\nUse the create_pr tool to open PRs.",
    }),
  );
  assert.match(p, /<skills>/);
  assert.match(p, /- deploy: ship the app/);
  assert.match(p, /# MCP server instructions/);
  assert.match(p, /Use the create_pr tool/);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);

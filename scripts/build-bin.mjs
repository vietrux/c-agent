#!/usr/bin/env node
// Cross-compile standalone c-agent binaries for the common OS/arch targets.
// Uses Bun's --compile (bundles the Bun runtime + app into one executable).
// Run: node scripts/build-bin.mjs  [target ...]   (no args = all targets)
import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";

const TARGETS = [
  { name: "linux-x64", bun: "bun-linux-x64" },
  { name: "linux-arm64", bun: "bun-linux-arm64" },
  { name: "darwin-x64", bun: "bun-darwin-x64" },
  { name: "darwin-arm64", bun: "bun-darwin-arm64" },
  { name: "windows-x64", bun: "bun-windows-x64", ext: ".exe" },
];

const OUT = "dist-bin";
const ENTRY = "src/index.ts";

if (spawnSync("bun", ["--version"], { stdio: "ignore" }).status !== 0) {
  console.error("bun is required to build binaries — https://bun.sh");
  process.exit(1);
}

const want = process.argv.slice(2);
const selected = want.length
  ? TARGETS.filter((t) => want.includes(t.name))
  : TARGETS;
if (selected.length === 0) {
  console.error(`unknown target(s): ${want.join(", ")}`);
  console.error(`available: ${TARGETS.map((t) => t.name).join(", ")}`);
  process.exit(1);
}

mkdirSync(OUT, { recursive: true });

let failed = 0;
for (const t of selected) {
  const outfile = `${OUT}/cagent-${t.name}${t.ext ?? ""}`;
  process.stdout.write(`building ${t.name} → ${outfile}\n`);
  const r = spawnSync(
    "bun",
    [
      "build", ENTRY,
      "--compile",
      "--bytecode",
      "--minify",
      "--sourcemap=none",
      `--target=${t.bun}`,
      "--outfile", outfile,
    ],
    { stdio: "inherit" },
  );
  if (r.status !== 0) {
    console.error(`  ✗ ${t.name} failed`);
    failed++;
  }
}

if (failed) {
  console.error(`\n${failed}/${selected.length} target(s) failed`);
  process.exit(1);
}
console.log(`\n✓ built ${selected.length} binar${selected.length === 1 ? "y" : "ies"} in ${OUT}/`);

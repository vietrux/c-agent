#!/usr/bin/env node
// Build standalone binaries via @yao-pkg/pkg.
// Pipeline: bun bundle (CJS, minified) → pkg V8-snapshot compile.
// Cross-compiles for all major OS/arch targets.
// Run: node scripts/build-pkg.mjs  [target ...]   (no args = all targets)
import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";

const BUNDLE = "dist-pkg/bundle.cjs";
const OUT = "dist-bin";
const ENTRY = "src/index.ts";
const NODE_VER = "node22";

const TARGETS = [
  { name: "linux-x64",    pkg: `${NODE_VER}-linux-x64` },
  { name: "linux-arm64",  pkg: `${NODE_VER}-linux-arm64` },
  { name: "darwin-x64",   pkg: `${NODE_VER}-macos-x64` },
  { name: "darwin-arm64", pkg: `${NODE_VER}-macos-arm64` },
  { name: "windows-x64",  pkg: `${NODE_VER}-win-x64`, ext: ".exe" },
];

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { stdio: "inherit", ...opts });
  return r.status ?? 1;
}

// ── bundle ───────────────────────────────────────────────────────────────────
mkdirSync("dist-pkg", { recursive: true });
mkdirSync(OUT, { recursive: true });

console.log("bundling → " + BUNDLE);
const bundleStatus = run("bun", [
  "build", ENTRY,
  "--format=cjs",
  "--target=node",
  "--minify",
  "--sourcemap=none",
  "--outfile", BUNDLE,
]);
if (bundleStatus !== 0) {
  console.error("bundle failed");
  process.exit(1);
}

// ── compile ──────────────────────────────────────────────────────────────────
const want = process.argv.slice(2);
const selected = want.length
  ? TARGETS.filter((t) => want.includes(t.name))
  : TARGETS;

if (selected.length === 0) {
  console.error(`unknown target(s): ${want.join(", ")}`);
  console.error(`available: ${TARGETS.map((t) => t.name).join(", ")}`);
  process.exit(1);
}

let failed = 0;
for (const t of selected) {
  const outfile = `${OUT}/cagent-${t.name}${t.ext ?? ""}`;
  console.log(`compiling ${t.name} → ${outfile}`);
  const status = run("npx", [
    "@yao-pkg/pkg", BUNDLE,
    "--target", t.pkg,
    "--output", outfile,
    "--compress", "Brotli",
  ]);
  if (status !== 0) {
    console.error(`  ✗ ${t.name} failed`);
    failed++;
  }
}

if (failed) {
  console.error(`\n${failed}/${selected.length} target(s) failed`);
  process.exit(1);
}
console.log(`\n✓ built ${selected.length} binar${selected.length === 1 ? "y" : "ies"} in ${OUT}/`);

import { strict as assert } from "node:assert";
import { PermissionEngine } from "./src/permissions.js";
import {
  clearWebFetchCache,
  isAllowedRedirect,
  validateWebFetchUrl,
  webFetchCacheSize,
} from "./src/tools/web-fetch.js";

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

console.log("\nweb_fetch hardening");

await test("validateWebFetchUrl accepts public http/https URLs", () => {
  assert.equal(validateWebFetchUrl("https://example.com/path").ok, true);
  assert.equal(validateWebFetchUrl("http://example.com/path").ok, true);
});

await test("validateWebFetchUrl rejects unsafe URL shapes", () => {
  assert.equal(validateWebFetchUrl("ftp://example.com/file").ok, false);
  assert.equal(validateWebFetchUrl("https://user:pass@example.com").ok, false);
  assert.equal(validateWebFetchUrl("https://localhost/path").ok, false);
  assert.equal(validateWebFetchUrl("not-a-url").ok, false);
});

await test("isAllowedRedirect allows same host and www-normalized redirects", () => {
  assert.equal(
    isAllowedRedirect(
      new URL("https://example.com/start"),
      new URL("https://example.com/next"),
    ),
    true,
  );
  assert.equal(
    isAllowedRedirect(
      new URL("https://example.com/start"),
      new URL("https://www.example.com/next"),
    ),
    true,
  );
});

await test("isAllowedRedirect rejects cross-domain, protocol, and credential redirects", () => {
  assert.equal(
    isAllowedRedirect(
      new URL("https://example.com/start"),
      new URL("https://evil.example/next"),
    ),
    false,
  );
  assert.equal(
    isAllowedRedirect(
      new URL("https://example.com/start"),
      new URL("http://example.com/next"),
    ),
    false,
  );
  assert.equal(
    isAllowedRedirect(
      new URL("https://example.com/start"),
      new URL("https://user@example.com/next"),
    ),
    false,
  );
});

await test("PermissionEngine suggests domain-scoped web_fetch rules", () => {
  const engine = new PermissionEngine({});
  const rule = engine.suggestRule("web_fetch", {
    url: "https://docs.example.com/reference?q=1",
  });
  assert.equal(rule?.spec, "web_fetch(*://docs.example.com/*)");
  assert.equal(rule?.label, "docs.example.com");
});

await test("web_fetch cache helpers clear cache state", () => {
  clearWebFetchCache();
  assert.equal(webFetchCacheSize(), 0);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);

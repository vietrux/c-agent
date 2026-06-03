import { ProcessManager } from "./src/process/manager.js";
import { httpRequestTool } from "./src/tools/http.js";
import { codecTool } from "./src/tools/codec.js";
import { notesTool } from "./src/tools/notes.js";
import type { ToolContext } from "./src/tools/registry.js";

const pm = new ProcessManager();
const ctx: ToolContext = { pm, cwd: process.cwd(), todos: [] };

let passed = 0;
let failed = 0;

function check(name: string, ok: boolean, detail = "") {
  if (ok) { console.log(`  ✓ ${name}`); passed++; }
  else { console.log(`  ✗ ${name}${detail ? ": " + detail : ""}`); failed++; }
}

// ── encode_decode ─────────────────────────────────────────────────────────────
console.log("\nencode_decode");

const b64e = await codecTool.run({ op: "base64_encode", input: "hello" }, ctx);
check("base64_encode", b64e.text === "aGVsbG8=", b64e.text);

const b64d = await codecTool.run({ op: "base64_decode", input: "aGVsbG8=" }, ctx);
check("base64_decode", b64d.text === "hello", b64d.text);

const b64ue = await codecTool.run({ op: "base64url_encode", input: "hello" }, ctx);
check("base64url_encode", b64ue.text === "aGVsbG8", b64ue.text); // base64url omits = padding

const urle = await codecTool.run({ op: "url_encode", input: "hello world&foo=bar" }, ctx);
check("url_encode", urle.text === "hello%20world%26foo%3Dbar", urle.text);

const urld = await codecTool.run({ op: "url_decode", input: "hello%20world%26foo%3Dbar" }, ctx);
check("url_decode", urld.text === "hello world&foo=bar", urld.text);

const hexe = await codecTool.run({ op: "hex_encode", input: "abc" }, ctx);
check("hex_encode", hexe.text === "616263", hexe.text);

const hexd = await codecTool.run({ op: "hex_decode", input: "616263" }, ctx);
check("hex_decode", hexd.text === "abc", hexd.text);

const htmle = await codecTool.run({ op: "html_encode", input: '<script>alert("xss")</script>' }, ctx);
check("html_encode", htmle.text === "&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;", htmle.text);

const htmld = await codecTool.run({ op: "html_decode", input: "&lt;b&gt;hi&lt;/b&gt;" }, ctx);
check("html_decode", htmld.text === "<b>hi</b>", htmld.text);

const jwt = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiaWF0IjoxNTE2MjM5MDIyfQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";
const jwtd = await codecTool.run({ op: "jwt_decode", input: jwt }, ctx);
check("jwt_decode header", jwtd.text.includes('"alg"'), jwtd.text.slice(0, 80));
check("jwt_decode payload", jwtd.text.includes('"sub"'), jwtd.text.slice(0, 80));

const md5 = await codecTool.run({ op: "hash_md5", input: "hello" }, ctx);
check("hash_md5", md5.text === "5d41402abc4b2a76b9719d911017c592", md5.text);

const sha256 = await codecTool.run({ op: "hash_sha256", input: "hello" }, ctx);
check("hash_sha256", sha256.text === "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824", sha256.text);

const rot = await codecTool.run({ op: "rot13", input: "Hello World" }, ctx);
check("rot13", rot.text === "Uryyb Jbeyq", rot.text);

const xorr = await codecTool.run({ op: "xor", input: "ABC", key: "ff" }, ctx);
check("xor hex key", !xorr.isError && xorr.text === "bebdbc", xorr.text);

const xorp = await codecTool.run({ op: "xor", input: "AB", key: "X" }, ctx);
check("xor plain key", !xorp.isError, xorp.text);

const xornk = await codecTool.run({ op: "xor", input: "test" }, ctx);
check("xor no key → error", xornk.isError === true, xornk.text);

const unk = await codecTool.run({ op: "bad_op", input: "x" }, ctx);
check("unknown op → error", unk.isError === true, unk.text);

// ── notes ─────────────────────────────────────────────────────────────────────
console.log("\nnotes");

const KEY = `__test_${Date.now()}`;
const KEY2 = `__test2_${Date.now()}`;

const ns = await notesTool.run({ action: "set", key: KEY, value: "s3cr3t" }, ctx);
check("set", !ns.isError, ns.text);

const ng = await notesTool.run({ action: "get", key: KEY }, ctx);
check("get", ng.text === "s3cr3t", ng.text);

const ns2 = await notesTool.run({ action: "set", key: KEY2, value: "val2" }, ctx);
check("set second", !ns2.isError, ns2.text);

const nl = await notesTool.run({ action: "list" }, ctx);
check("list contains both keys", nl.text.includes(KEY) && nl.text.includes(KEY2), nl.text.slice(0, 120));

const nd = await notesTool.run({ action: "delete", key: KEY }, ctx);
check("delete", !nd.isError, nd.text);

const ng2 = await notesTool.run({ action: "get", key: KEY }, ctx);
check("get after delete → error", ng2.isError === true, ng2.text);

const nmk = await notesTool.run({ action: "get", key: "__nonexistent_xyz" }, ctx);
check("get missing key → error", nmk.isError === true, nmk.text);

const nnk = await notesTool.run({ action: "set" }, ctx);
check("set no key → error", nnk.isError === true, nnk.text);

// clean up KEY2 without confirm (ctx has no confirm fn)
await notesTool.run({ action: "delete", key: KEY2 }, ctx);

// ── http_request ──────────────────────────────────────────────────────────────
console.log("\nhttp_request");

// invalid URL must return error, never throw
const hbad = await httpRequestTool.run({ url: "not-a-url" }, ctx);
check("invalid url → error", hbad.isError === true, hbad.text.slice(0, 80));

// real network (may fail in sandboxed env — that's OK, just can't throw)
const hget = await httpRequestTool.run({ url: "https://httpbin.org/get", timeout_ms: 8_000 }, ctx);
if (!hget.isError) {
  check("GET httpbin/get → 200", hget.text.startsWith("HTTP 200"), hget.text.slice(0, 40));
  check("GET response has headers", hget.text.includes("content-type:"), hget.text.slice(0, 120));
  check("GET response has body", hget.text.includes("httpbin"), hget.text.slice(0, 200));
} else {
  console.log(`  ~ http network test skipped (${hget.text.slice(0, 60)})`);
}

// POST with body + headers
const hpost = await httpRequestTool.run({
  url: "https://httpbin.org/post",
  method: "POST",
  headers: { "Content-Type": "application/json", "X-Custom": "redteam" },
  body: JSON.stringify({ test: true }),
  timeout_ms: 8_000,
}, ctx);
if (!hpost.isError) {
  check("POST 200", hpost.text.startsWith("HTTP 200"), hpost.text.slice(0, 40));
  check("POST body echoed", hpost.text.includes('"test"'), hpost.text.slice(0, 300));
} else {
  console.log(`  ~ POST network test skipped (${hpost.text.slice(0, 60)})`);
}

// ── summary ───────────────────────────────────────────────────────────────────
console.log(`\n${passed} passed, ${failed} failed`);
pm.killAll();
if (failed > 0) process.exit(1);

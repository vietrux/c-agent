import { createHash } from "node:crypto";
import type { Tool } from "./registry.js";

const HTML_ENC: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};
const HTML_DEC: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
};

export const codecTool: Tool = {
  spec: {
    name: "encode_decode",
    description:
      "Encode, decode, or hash a string. op: " +
      "base64_encode, base64_decode, base64url_encode, base64url_decode, " +
      "url_encode, url_decode, " +
      "hex_encode, hex_decode, " +
      "html_encode, html_decode, " +
      "jwt_decode (header+payload only, no sig verify), " +
      "hash_md5, hash_sha1, hash_sha256, hash_sha512, " +
      "rot13, " +
      "xor (requires key: even-length hex string like 'deadbeef', or plain text).",
    parameters: {
      type: "object",
      properties: {
        op: { type: "string" },
        input: { type: "string" },
        key: { type: "string", description: "required for xor" },
      },
      required: ["op", "input"],
    },
  },
  async run(input, _ctx) {
    const op = input.op as string;
    const data = input.input as string;
    const key = input.key as string | undefined;

    try {
      switch (op) {
        case "base64_encode":
          return { text: Buffer.from(data, "utf8").toString("base64") };
        case "base64_decode":
          return { text: Buffer.from(data, "base64").toString("utf8") };
        case "base64url_encode":
          return { text: Buffer.from(data, "utf8").toString("base64url") };
        case "base64url_decode":
          return { text: Buffer.from(data, "base64url").toString("utf8") };
        case "url_encode":
          return { text: encodeURIComponent(data) };
        case "url_decode":
          return { text: decodeURIComponent(data) };
        case "hex_encode":
          return { text: Buffer.from(data, "utf8").toString("hex") };
        case "hex_decode":
          return { text: Buffer.from(data, "hex").toString("utf8") };
        case "html_encode":
          return { text: data.replace(/[&<>"']/g, (c) => HTML_ENC[c] ?? c) };
        case "html_decode":
          return {
            text: data.replace(/&amp;|&lt;|&gt;|&quot;|&#39;/g, (e) => HTML_DEC[e] ?? e),
          };
        case "jwt_decode": {
          const parts = data.split(".");
          if (parts.length < 2)
            return { text: "invalid JWT: expected at least 2 parts", isError: true };
          const header = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8"));
          const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
          return { text: JSON.stringify({ header, payload }, null, 2) };
        }
        case "hash_md5":
          return { text: createHash("md5").update(data).digest("hex") };
        case "hash_sha1":
          return { text: createHash("sha1").update(data).digest("hex") };
        case "hash_sha256":
          return { text: createHash("sha256").update(data).digest("hex") };
        case "hash_sha512":
          return { text: createHash("sha512").update(data).digest("hex") };
        case "rot13":
          return {
            text: data.replace(/[a-zA-Z]/g, (c) => {
              const base = c <= "Z" ? 65 : 97;
              return String.fromCharCode(((c.charCodeAt(0) - base + 13) % 26) + base);
            }),
          };
        case "xor": {
          if (!key) return { text: "xor requires key", isError: true };
          const isHexKey = /^[0-9a-fA-F]+$/.test(key) && key.length % 2 === 0;
          const keyBuf = isHexKey ? Buffer.from(key, "hex") : Buffer.from(key, "utf8");
          const inBuf = Buffer.from(data, "utf8");
          const out = Buffer.alloc(inBuf.length);
          for (let i = 0; i < inBuf.length; i++) out[i] = inBuf[i] ^ keyBuf[i % keyBuf.length];
          return { text: out.toString("hex") };
        }
        default:
          return { text: `unknown op: ${op}`, isError: true };
      }
    } catch (err: any) {
      return { text: `${op} failed: ${err?.message ?? String(err)}`, isError: true };
    }
  },
};

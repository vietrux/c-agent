import { createHash } from "node:crypto";
import CryptoJS from "crypto-js";
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

// Symmetric ciphers. crypto-js derives key+IV from the passphrase via OpenSSL's
// EVP_BytesToKey with a random salt, so encrypt output is the base64
// "Salted__" format and decrypt only needs the same passphrase — compatible
// with `openssl enc -<algo> -a -salt`.
const CIPHERS: Record<string, typeof CryptoJS.AES> = {
  aes: CryptoJS.AES,
  des: CryptoJS.DES,
  "3des": CryptoJS.TripleDES,
  tripledes: CryptoJS.TripleDES,
  rc4: CryptoJS.RC4,
  rabbit: CryptoJS.Rabbit,
};

// crypto-js hashers that node's `crypto` doesn't cover out of the box.
const CJS_HASHES: Record<string, (m: string) => CryptoJS.lib.WordArray> = {
  hash_sha224: CryptoJS.SHA224,
  hash_sha384: CryptoJS.SHA384,
  hash_sha3: (m) => CryptoJS.SHA3(m, { outputLength: 512 }),
  hash_ripemd160: CryptoJS.RIPEMD160,
};

const HMACS: Record<string, (m: string, k: string) => CryptoJS.lib.WordArray> = {
  hmac_md5: CryptoJS.HmacMD5,
  hmac_sha1: CryptoJS.HmacSHA1,
  hmac_sha256: CryptoJS.HmacSHA256,
  hmac_sha512: CryptoJS.HmacSHA512,
};

export const codecTool: Tool = {
  concurrencySafe: true,
  spec: {
    name: "encode_decode",
    description:
      "Encode/decode, hash, encrypt/decrypt, or derive a key from a string. op: " +
      "base64_encode, base64_decode, base64url_encode, base64url_decode, " +
      "url_encode, url_decode, hex_encode, hex_decode, html_encode, html_decode, " +
      "jwt_decode (header+payload only, no sig verify), rot13, " +
      "xor (key: even-length hex like 'deadbeef' or plain text), " +
      "hash_md5, hash_sha1, hash_sha256, hash_sha512, hash_sha224, hash_sha384, " +
      "hash_sha3, hash_ripemd160, " +
      "hmac_md5, hmac_sha1, hmac_sha256, hmac_sha512 (key required), " +
      "pbkdf2 (key=salt; iterations/keySize optional), " +
      "<cipher>_encrypt / <cipher>_decrypt where cipher is aes, des, 3des, rc4, " +
      "or rabbit (key required = passphrase; OpenSSL-compatible salted base64).",
    parameters: {
      type: "object",
      properties: {
        op: { type: "string" },
        input: { type: "string" },
        key: { type: "string", description: "passphrase/secret/salt — required for xor, hmac_*, pbkdf2, and *_encrypt/*_decrypt" },
        iterations: { type: "integer", description: "pbkdf2 iteration count (default 10000)" },
        keySize: { type: "integer", description: "pbkdf2 derived key size in bits (default 256)" },
      },
      required: ["op", "input"],
    },
  },
  async run(input, _ctx) {
    const op = input.op as string;
    const data = input.input as string;
    const key = input.key as string | undefined;

    try {
      // Symmetric encrypt/decrypt: aes_encrypt, 3des_decrypt, rc4_encrypt, …
      const cipherMatch = /^([a-z0-9]+)_(encrypt|decrypt)$/.exec(op);
      if (cipherMatch) {
        const [, algo, dir] = cipherMatch;
        const cipher = CIPHERS[algo];
        if (!cipher) return { text: `unknown cipher: ${algo}`, isError: true };
        if (!key) return { text: `${op} requires key (passphrase)`, isError: true };
        if (dir === "encrypt") return { text: cipher.encrypt(data, key).toString() };
        const out = cipher.decrypt(data, key).toString(CryptoJS.enc.Utf8);
        if (!out)
          return { text: "decrypt failed: wrong key or corrupt ciphertext", isError: true };
        return { text: out };
      }

      if (op in CJS_HASHES) return { text: CJS_HASHES[op](data).toString() };

      if (op in HMACS) {
        if (!key) return { text: `${op} requires key`, isError: true };
        return { text: HMACS[op](data, key).toString() };
      }

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
        case "pbkdf2": {
          if (!key) return { text: "pbkdf2 requires key (salt)", isError: true };
          const iterations =
            typeof input.iterations === "number" ? input.iterations : 10000;
          const keySizeBits =
            typeof input.keySize === "number" ? input.keySize : 256;
          const derived = CryptoJS.PBKDF2(data, key, {
            keySize: keySizeBits / 32,
            iterations,
          });
          return { text: derived.toString() };
        }
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

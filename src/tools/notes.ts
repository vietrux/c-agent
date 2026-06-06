import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import type { Tool } from "./registry.js";
import { writeSecureFile } from "../utils/secure-fs.js";

const NOTES_DIR = join(homedir(), ".c-agent");
const NOTES_FILE = join(NOTES_DIR, "notes.json");

async function load(): Promise<Record<string, string>> {
  try {
    return JSON.parse(await readFile(NOTES_FILE, "utf8"));
  } catch {
    return {};
  }
}

async function save(notes: Record<string, string>): Promise<void> {
  writeSecureFile(NOTES_FILE, JSON.stringify(notes, null, 2)); // 0600 — may hold credentials
}

export const notesTool: Tool = {
  spec: {
    name: "notes",
    description:
      "Persistent key-value store across sessions saved to ~/.c-agent/notes.json. " +
      "Use for SSH creds to reuse later, server IPs to deploy code, API keys, project state, config values, reminders — anything worth persisting across sessions. " +
      "\n\n" +
      "CRITICAL — a FUTURE session reads these notes with ZERO memory of this conversation. A key like `ip` or `password` is useless later: which host? which user? what for? Make every entry self-explanatory on its own.\n" +
      "\n" +
      "KEY NAMING — use a descriptive, namespaced path so the key alone identifies the entry:\n" +
      "  format: <domain>/<context-semi-detail>/<field>\n" +
      "  use lowercase kebab segments; pack the context segment with env + role + unique id (e.g. `prod-web-01`, `staging-pg-primary`) so it is searchable later.\n" +
      "  good:  `ssh/prod-web-01/host`, `ssh/prod-web-01/user`, `ssh/prod-web-01/port`, `apikey/stripe-project-03/live`, `db/staging-pg-primary/conn-string`\n" +
      "  bad:   `ip`, `key`, `pass`, `server` (ambiguous across sessions)\n" +
      "\n" +
      "VALUE — make it self-describing, not a bare token. Include what it is, what it is for, and any usage hint a future session needs:\n" +
      "  good:  `203.0.113.7 — prod web server, SSH in as `deploy` on port 2222 to ship the c-agent release build`\n" +
      "  bad:   `203.0.113.7`\n" +
      "Group related facts (host+user+port+purpose of ONE server) under one shared `<domain>/<context>/` prefix so a future session can find all parts together.\n" +
      "\n" +
      "Before `set`, run `list` first to check naming/avoid duplicate or colliding keys.\n" +
      "\n" +
      "action=set: store key+value (use namespaced key + self-describing value as above). " +
      "action=get: retrieve by exact key. " +
      "action=list: show all keys (values truncated). " +
      "action=search: ranked fuzzy lookup (param `query`) when you don't know the exact key. Splits query into terms, ignores / - _ . separators (so `prod web 01` matches `prod-web-01`), scores key matches above value matches, returns hits sorted by relevance with a leading [score]. Prefer this over list to find related entries. " +
      "action=delete: remove one key. " +
      "action=clear: wipe all entries (destructive, prompts for confirmation).",
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["set", "get", "list", "search", "delete", "clear"],
        },
        key: { type: "string" },
        value: { type: "string" },
        query: {
          type: "string",
          description: "substring to match for action=search",
        },
      },
      required: ["action"],
    },
  },
  async run(input, ctx) {
    const action = input.action as string;
    const key = input.key as string | undefined;
    const value = input.value as string | undefined;
    const query = input.query as string | undefined;

    if (action === "clear" && ctx.confirm) {
      const d = await ctx.confirm({
        name: "notes",
        preview: "clear ALL notes (irreversible)",
      });
      if (d.decision === "deny")
        return { text: "✗ denied by user", isError: true };
    }

    const notes = await load();

    switch (action) {
      case "set": {
        if (!key) return { text: "key required", isError: true };
        if (value === undefined)
          return { text: "value required", isError: true };
        notes[key] = value;
        await save(notes);
        return { text: `set: ${key}` };
      }
      case "get": {
        if (!key) return { text: "key required", isError: true };
        const v = notes[key];
        return v !== undefined
          ? { text: v }
          : { text: `not found: ${key}`, isError: true };
      }
      case "list": {
        const entries = Object.entries(notes);
        if (entries.length === 0) return { text: "(empty)" };
        const preview = (v: string) =>
          v.length > 80 ? `${v.slice(0, 80)}…` : v;
        return {
          text: entries.map(([k, v]) => `${k}: ${preview(v)}`).join("\n"),
        };
      }
      case "search": {
        if (!query) return { text: "query required", isError: true };
        // normalize path separators (/ - _ .) to spaces so `prod web 01`
        // matches `prod-web-01` and `ssh/prod-web-01/host`
        const norm = (s: string) => s.toLowerCase().replace(/[/\-_.]+/g, " ");
        const nq = norm(query).trim();
        const terms = nq.split(/\s+/).filter(Boolean);
        if (terms.length === 0)
          return { text: "query required", isError: true };

        const scored = Object.entries(notes)
          .map(([k, v]) => {
            const nk = norm(k);
            const nv = norm(v);
            let score = 0;
            for (const t of terms) {
              if (nk.includes(t)) score += 3; // key match weighted high
              if (nv.includes(t)) score += 1; // value match
            }
            if (terms.every((t) => nk.includes(t)))
              score += 5; // all terms in key
            else if (terms.every((t) => nk.includes(t) || nv.includes(t)))
              score += 2; // all terms somewhere
            if (nk.includes(nq)) score += 4; // contiguous phrase in key
            return { k, v, score };
          })
          .filter((e) => e.score > 0)
          .sort((a, b) => b.score - a.score || a.k.localeCompare(b.k));

        if (scored.length === 0) return { text: `no match: ${query}` };
        return {
          text: scored.map((e) => `[${e.score}] ${e.k}: ${e.v}`).join("\n"),
        };
      }
      case "delete": {
        if (!key) return { text: "key required", isError: true };
        if (!(key in notes))
          return { text: `not found: ${key}`, isError: true };
        delete notes[key];
        await save(notes);
        return { text: `deleted: ${key}` };
      }
      case "clear": {
        await save({});
        return { text: "cleared" };
      }
      default:
        return { text: `unknown action: ${action}`, isError: true };
    }
  },
};

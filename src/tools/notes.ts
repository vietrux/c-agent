import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import type { Tool } from "./registry.js";

const NOTES_DIR = join(homedir(), ".cagent");
const NOTES_FILE = join(NOTES_DIR, "notes.json");

async function load(): Promise<Record<string, string>> {
  try {
    return JSON.parse(await readFile(NOTES_FILE, "utf8"));
  } catch {
    return {};
  }
}

async function save(notes: Record<string, string>): Promise<void> {
  await mkdir(NOTES_DIR, { recursive: true });
  await writeFile(NOTES_FILE, JSON.stringify(notes, null, 2), "utf8");
}

export const notesTool: Tool = {
  spec: {
    name: "notes",
    description:
      "Persistent key-value store across sessions saved to ~/.cagent/notes.json. " +
      "Use for creds, live hosts, shell access, flags, IPs, tokens — anything to remember, project state, config values, reminders — anything worth persisting across sessions. " +
      "action=set: store key+value. " +
      "action=get: retrieve by key. " +
      "action=list: show all entries. " +
      "action=delete: remove one key. " +
      "action=clear: wipe all entries (destructive, prompts for confirmation).",
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["set", "get", "list", "delete", "clear"],
        },
        key: { type: "string" },
        value: { type: "string" },
      },
      required: ["action"],
    },
  },
  async run(input, ctx) {
    const action = input.action as string;
    const key = input.key as string | undefined;
    const value = input.value as string | undefined;

    if (action === "clear" && ctx.confirm) {
      const d = await ctx.confirm({
        name: "notes",
        preview: "clear ALL notes (irreversible)",
      });
      if (d.decision === "deny") return { text: "✗ denied by user", isError: true };
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
        return { text: entries.map(([k, v]) => `${k}: ${v}`).join("\n") };
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

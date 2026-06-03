import { randomUUID } from "node:crypto";
import type { NeutralMessage } from "./provider/types.js";

/**
 * Strip system-injected blocks from a user message for DISPLAY/labels. The blocks
 * stay in the stored transcript (the model relied on them) but should never be
 * shown back to the user (live or on resume).
 */
export function stripInjected(text: string): string {
  return text
    .replace(/<background-task-updates>[\s\S]*?<\/background-task-updates>\s*/g, "")
    .replace(/<hook-context>[\s\S]*?<\/hook-context>\s*/g, "")
    .trim();
}

export interface Checkpoint {
  label: string; // preview of the user message
  msgIndex: number; // index into messages BEFORE this user turn was pushed
  fileMark: number; // file-snapshot count at the start of this turn (for rewind)
}

export interface SessionData {
  id: string;
  cwd: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messages: NeutralMessage[];
  checkpoints: Checkpoint[];
}

/**
 * Holds the model transcript (provider-neutral) plus per-user-turn checkpoints
 * so the UI can rewind: truncate back to a chosen point and resend.
 */
export class Session {
  readonly id: string;
  readonly cwd: string;
  title = "";
  readonly createdAt: number;
  updatedAt: number;
  messages: NeutralMessage[] = [];
  checkpoints: Checkpoint[] = [];

  /** Called after any mutation so a store can persist. */
  onChange?: () => void;

  constructor(cwd: string, id: string = randomUUID(), createdAt: number = Date.now()) {
    this.cwd = cwd;
    this.id = id;
    this.createdAt = createdAt;
    this.updatedAt = createdAt;
  }

  static fromData(d: SessionData): Session {
    const s = new Session(d.cwd, d.id, d.createdAt);
    s.title = d.title;
    s.updatedAt = d.updatedAt;
    s.messages = d.messages;
    s.checkpoints = d.checkpoints;
    return s;
  }

  toData(): SessionData {
    return {
      id: this.id,
      cwd: this.cwd,
      title: this.title,
      createdAt: this.createdAt,
      updatedAt: this.updatedAt,
      messages: this.messages,
      checkpoints: this.checkpoints,
    };
  }

  private touched() {
    this.updatedAt = Date.now();
    this.onChange?.();
  }

  /**
   * Begin a user turn. Any `notes` (e.g. background-task updates) are pushed as
   * their own messages first; the checkpoint points at the start of the turn so
   * a rewind drops the notes too.
   */
  pushUser(text: string, fileMark = 0, notes: string[] = []) {
    const display = stripInjected(text).replace(/\s+/g, " ");
    if (!this.title) this.title = display.slice(0, 80);
    this.checkpoints.push({
      label: display.slice(0, 60),
      msgIndex: this.messages.length, // start of turn (before any notes)
      fileMark,
    });
    for (const n of notes) this.messages.push({ role: "note", content: n });
    this.messages.push({ role: "user", content: text });
    this.touched();
  }

  push(msg: NeutralMessage) {
    this.messages.push(msg);
    this.touched();
  }

  /** Drop everything from checkpoint i onward. Returns the user text rewound to. */
  rewindTo(i: number): string | null {
    const cp = this.checkpoints[i];
    if (!cp) return null;
    // The user message sits at/after msgIndex (notes may precede it in the turn).
    let userText = "";
    for (let j = cp.msgIndex; j < this.messages.length; j++) {
      const m = this.messages[j];
      if (m.role === "user") {
        userText = m.content;
        break;
      }
    }
    this.messages.length = cp.msgIndex;
    this.checkpoints.length = i;
    this.touched();
    return userText;
  }

  /** Replace the transcript wholesale (used by compaction). */
  replace(messages: NeutralMessage[], checkpoints: Checkpoint[]) {
    this.messages = messages;
    this.checkpoints = checkpoints;
    this.touched();
  }

  clear() {
    this.messages = [];
    this.checkpoints = [];
    this.touched();
  }
}

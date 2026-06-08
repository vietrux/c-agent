export type SubStatus = "running" | "done" | "error" | "cancelled";

export interface SubRecord {
  id: string;
  label: string; // agent type
  prompt: string;
  status: SubStatus;
  startedAt: number;
  finishedAt?: number;
  result?: string; // final summary text on success
  error?: string;
}

/** A launched subagent: a promise for its final text + a way to abort it. */
export interface SubHandle {
  done: Promise<string>;
  abort: () => void;
}

/**
 * Tracks background subagents the way ProcessManager tracks background shells:
 * each runs detached from the turn that started it; on completion `onExit` fires
 * so the TUI can surface a result note and wake the agent (notify-style).
 */
export class SubagentManager {
  private recs = new Map<string, SubRecord>();
  private aborts = new Map<string, () => void>();
  private seq = 0;

  /** Fired once when a background subagent settles (done/error/cancelled). */
  onExit?: (rec: SubRecord) => void;

  list(): SubRecord[] {
    return [...this.recs.values()];
  }

  /** Launch a subagent in the background. Returns its id immediately. */
  start(label: string, prompt: string, launch: () => SubHandle): string {
    const id = `sub-${++this.seq}`;
    this.recs.set(id, {
      id,
      label,
      prompt,
      status: "running",
      startedAt: Date.now(),
    });
    const { done, abort } = launch();
    this.aborts.set(id, abort);
    done.then(
      (text) => this.settle(id, "done", text, undefined),
      (err) => this.settle(id, "error", undefined, String(err?.message ?? err)),
    );
    return id;
  }

  /** Cancel a running subagent. Returns false if unknown or already settled. */
  kill(id: string): boolean {
    const rec = this.recs.get(id);
    if (!rec || rec.status !== "running") return false;
    this.aborts.get(id)?.();
    this.settle(id, "cancelled", undefined, undefined);
    return true;
  }

  private settle(id: string, status: SubStatus, result?: string, error?: string) {
    const rec = this.recs.get(id);
    if (!rec || rec.status !== "running") return; // already settled (e.g. abort race)
    rec.status = status;
    rec.finishedAt = Date.now();
    rec.result = result;
    rec.error = error;
    this.aborts.delete(id);
    this.onExit?.(rec);
  }
}

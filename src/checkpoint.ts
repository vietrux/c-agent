import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname } from "node:path";

interface Snapshot {
  path: string;
  existed: boolean;
  content: string; // prior content (empty if it did not exist)
}

/**
 * In-memory undo log for file mutations. write/edit call snapshot(path) BEFORE
 * touching a file; rewind restores every file changed at/after a given mark to
 * its prior state. Mark = number of snapshots recorded so far at turn start.
 */
export class FileCheckpointer {
  private log: Snapshot[] = [];

  get mark(): number {
    return this.log.length;
  }

  /** Record the current state of a path before it is mutated. */
  snapshot(path: string) {
    const existed = existsSync(path);
    let content = "";
    if (existed) {
      try {
        content = readFileSync(path, "utf8");
      } catch {
        return; // unreadable (e.g. binary/permission) — skip, can't undo
      }
    }
    this.log.push({ path, existed, content });
  }

  /** Drop the undo log without restoring (used when switching sessions). */
  clear() {
    this.log.length = 0;
  }

  /** Restore files to the state they had at `mark`, newest snapshot first. */
  restoreTo(mark: number) {
    for (let i = this.log.length - 1; i >= mark; i--) {
      const s = this.log[i];
      try {
        if (s.existed) {
          mkdirSync(dirname(s.path), { recursive: true });
          writeFileSync(s.path, s.content, "utf8");
        } else if (existsSync(s.path)) {
          rmSync(s.path);
        }
      } catch {
        /* best effort */
      }
    }
    this.log.length = mark;
  }
}

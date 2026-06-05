import { spawn, ChildProcess } from "node:child_process";
import { createWriteStream, type WriteStream } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { ensureSecureDir } from "../utils/secure-fs.js";
import { subprocessEnv } from "../utils/subprocess-env.js";

export interface ProcRecord {
  id: string;
  command: string;
  child: ChildProcess;
  background: boolean;
  startedAt: number;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  running: boolean;
  output: string[]; // ring buffer of combined stdout+stderr lines (most recent RING_MAX)
  totalLines: number; // absolute count of completed lines ever emitted (cursor math)
  cursor: number; // absolute line index already returned by read() (incremental reads)
  partial: string; // incomplete trailing line not yet terminated by \n
  detach?: () => void; // resolve the waiting fg call early, keep process alive
  notify: boolean; // on exit, wake the agent immediately (vs inject next turn)
  autoBackgrounded: boolean; // moved to bg because it blew the fg budget (vs explicit/Ctrl+B)
  logPath?: string; // on-disk output log (background tasks persist here)
  logStream?: WriteStream;
}

export interface RunResult {
  id: string;
  background: boolean;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  output: string; // full captured output (fg) or initial snapshot (bg)
  timedOut: boolean;
  running: boolean;
  autoBackgrounded: boolean; // fg command exceeded its budget and was moved to bg
  outputPath?: string; // disk log path for background tasks
}

export interface ReadResult {
  text: string; // new output since the last read
  running: boolean;
  dropped: number; // lines evicted from the ring before the read cursor reached them
}

const RING_MAX = 5000; // max lines kept in memory per process
const TASKS_DIR = join(homedir(), ".c-agent", "tasks");

/**
 * Owns every child process the agent spawns. Foreground runs resolve on exit;
 * background runs return immediately and keep streaming into a ring buffer (and
 * a disk log) the agent can poll, read incrementally, tail, or kill by id.
 *
 * Every child is spawned `detached` so it leads its own process group; kills
 * signal the whole group (`kill(-pid)`) so wrappers like `bash -c "node srv"`
 * don't leave orphaned grandchildren — the same guarantee as Claude Code's
 * tree-kill.
 */
export class ProcessManager {
  private procs = new Map<string, ProcRecord>();
  private seq = 0;
  /** id of the running foreground job, if any (tools run one at a time). */
  private activeForeground: string | null = null;
  /** Fired when a backgrounded process exits, so the UI can notify the agent. */
  onBackgroundExit?: (rec: ProcRecord) => void;

  private nextId(): string {
    this.seq += 1;
    return `proc_${this.seq}`;
  }

  private push(rec: ProcRecord, chunk: Buffer) {
    const s = chunk.toString("utf8");
    rec.logStream?.write(s); // byte-exact persistence (background tasks)
    const text = rec.partial + s;
    const parts = text.split("\n");
    rec.partial = parts.pop() ?? "";
    for (const line of parts) {
      rec.output.push(line);
      rec.totalLines++;
    }
    if (rec.output.length > RING_MAX) {
      rec.output.splice(0, rec.output.length - RING_MAX);
    }
  }

  private flush(rec: ProcRecord) {
    if (rec.partial.length > 0) {
      rec.output.push(rec.partial);
      rec.totalLines++;
      rec.partial = "";
    }
  }

  /** Open the on-disk log and spill the current in-memory buffer into it. */
  private startFileLog(rec: ProcRecord) {
    if (rec.logStream) return;
    try {
      ensureSecureDir(TASKS_DIR);
      const path = join(TASKS_DIR, `${rec.id}.log`);
      const stream = createWriteStream(path, { flags: "a", mode: 0o600 });
      rec.logPath = path;
      rec.logStream = stream;
      // Spill what we already buffered so the file holds the full output.
      if (rec.output.length > 0) stream.write(rec.output.join("\n") + "\n");
      if (rec.partial) stream.write(rec.partial);
    } catch {
      /* logging is best-effort; in-memory ring still works */
    }
  }

  private closeLog(rec: ProcRecord) {
    if (rec.logStream) {
      try {
        rec.logStream.end();
      } catch {
        /* ignore */
      }
      rec.logStream = undefined;
    }
  }

  /** Move a foreground job to the background: persist output, flag notify. */
  private toBackground(rec: ProcRecord, notify: boolean) {
    if (rec.background) return;
    rec.background = true;
    rec.notify = notify;
    this.startFileLog(rec);
  }

  /**
   * Signal a process's entire group (tree-kill). The child leads its own group
   * (spawned detached), so the negative-pid kill reaches every descendant.
   * Falls back to a direct child kill if the group signal fails.
   */
  private killTree(rec: ProcRecord, signal: NodeJS.Signals = "SIGTERM"): boolean {
    const pid = rec.child.pid;
    if (!pid) return false;
    try {
      process.kill(-pid, signal); // negative pid → process group
      return true;
    } catch {
      try {
        return rec.child.kill(signal);
      } catch {
        return false;
      }
    }
  }

  run(opts: {
    command: string;
    cwd?: string;
    background?: boolean;
    timeoutMs?: number;
    notify?: boolean;
    /** When a foreground command blows its budget, move it to bg instead of killing it. */
    autoBackground?: boolean;
  }): Promise<RunResult> {
    const {
      command,
      cwd,
      background = false,
      timeoutMs = 120_000,
      notify = false,
      autoBackground = false,
    } = opts;
    const id = this.nextId();
    const child = spawn(command, {
      cwd,
      shell: true,
      env: subprocessEnv(), // strip provider/cloud secrets from the child
      detached: true, // own process group → group-kill reaches grandchildren
    });

    const rec: ProcRecord = {
      id,
      command,
      child,
      background,
      startedAt: Date.now(),
      exitCode: null,
      signal: null,
      running: true,
      output: [],
      totalLines: 0,
      cursor: 0,
      partial: "",
      notify,
      autoBackgrounded: false,
    };
    this.procs.set(id, rec);
    if (background) this.startFileLog(rec); // persist from the start

    child.stdout?.on("data", (c: Buffer) => this.push(rec, c));
    child.stderr?.on("data", (c: Buffer) => this.push(rec, c));

    const settle = new Promise<{ timedOut: boolean; backgrounded: boolean }>((resolve) => {
      let timer: NodeJS.Timeout | undefined;
      let timedOut = false;
      let done = false;
      const finish = (r: { timedOut: boolean; backgrounded: boolean }) => {
        if (done) return;
        done = true;
        if (timer) clearTimeout(timer);
        resolve(r);
      };
      if (!background && timeoutMs > 0) {
        timer = setTimeout(() => {
          // Budget exceeded: auto-background (keep running) or hard-kill.
          if (autoBackground) {
            rec.autoBackgrounded = true;
            this.toBackground(rec, true); // notify the agent when it eventually finishes
            finish({ timedOut: false, backgrounded: true });
          } else {
            timedOut = true;
            this.killTree(rec, "SIGTERM");
          }
        }, timeoutMs);
      }
      // Ctrl+B path: resolve the waiting fg call now but leave the process running.
      rec.detach = () => {
        this.toBackground(rec, rec.notify);
        finish({ timedOut: false, backgrounded: true });
      };
      child.on("exit", (code, signal) => {
        rec.running = false;
        rec.exitCode = code;
        rec.signal = signal;
        this.flush(rec);
        this.closeLog(rec);
        if (this.activeForeground === id) this.activeForeground = null;
        if (rec.background) this.onBackgroundExit?.(rec); // includes detached/auto-bg jobs
        finish({ timedOut, backgrounded: false });
      });
      child.on("error", (err) => {
        rec.running = false;
        this.push(rec, Buffer.from(`spawn error: ${err.message}`));
        this.closeLog(rec);
        if (this.activeForeground === id) this.activeForeground = null;
        finish({ timedOut, backgrounded: false });
      });
    });

    if (background) {
      // give it a beat to emit early output, then snapshot
      return new Promise((resolve) => {
        setTimeout(() => {
          resolve({
            id,
            background: true,
            exitCode: rec.exitCode,
            signal: rec.signal,
            output: rec.output.join("\n"),
            timedOut: false,
            running: rec.running,
            autoBackgrounded: false,
            outputPath: rec.logPath,
          });
        }, 150);
      });
    }

    this.activeForeground = id;
    return settle.then(({ timedOut, backgrounded }) => {
      if (this.activeForeground === id) this.activeForeground = null;
      return {
        id,
        background: backgrounded, // detached/auto-bg fg job reports as background
        exitCode: rec.exitCode,
        signal: rec.signal,
        output: rec.output.join("\n"),
        timedOut,
        running: rec.running,
        autoBackgrounded: rec.autoBackgrounded,
        outputPath: rec.logPath,
      };
    });
  }

  /** Last `lines` of output (snapshot), including any unterminated trailing line. */
  tail(id: string, lines = 50): string | null {
    const rec = this.procs.get(id);
    if (!rec) return null;
    const all = rec.partial ? [...rec.output, rec.partial] : rec.output;
    return all.slice(-lines).join("\n");
  }

  /**
   * New output since the last read (incremental cursor), optionally filtered by
   * a regex. Advances the cursor so the next call only returns fresh lines —
   * the same contract as Claude Code's BashOutput tool.
   */
  read(id: string, filter?: string): ReadResult | null {
    const rec = this.procs.get(id);
    if (!rec) return null;
    const ringBase = rec.totalLines - rec.output.length; // absolute index of output[0]
    const from = Math.max(rec.cursor, ringBase);
    const dropped = Math.max(0, ringBase - rec.cursor);
    let lines = rec.output.slice(from - ringBase);
    rec.cursor = rec.totalLines;
    if (filter) {
      try {
        const re = new RegExp(filter);
        lines = lines.filter((l) => re.test(l));
      } catch {
        /* invalid regex → return unfiltered */
      }
    }
    return { text: lines.join("\n"), running: rec.running, dropped };
  }

  /** On-disk log path for a process, if it has one. */
  outputPath(id: string): string | undefined {
    return this.procs.get(id)?.logPath;
  }

  list(): Array<Pick<ProcRecord, "id" | "command" | "background" | "running" | "exitCode">> {
    return [...this.procs.values()].map((r) => ({
      id: r.id,
      command: r.command,
      background: r.background,
      running: r.running,
      exitCode: r.exitCode,
    }));
  }

  kill(id: string, signal: NodeJS.Signals = "SIGTERM"): boolean {
    const rec = this.procs.get(id);
    if (!rec || !rec.running) return false;
    return this.killTree(rec, signal);
  }

  /** Move the running foreground job to the background. Returns its id, or null. */
  backgroundActive(notify = false): string | null {
    const id = this.activeForeground;
    if (!id) return null;
    const rec = this.procs.get(id);
    if (!rec || !rec.running || rec.background) return null;
    rec.notify = notify;
    rec.detach?.();
    return id;
  }

  /**
   * Kill every running foreground job (Esc interrupt). Background jobs the user
   * explicitly detached survive. Returns the count killed. Killing unblocks the
   * agent's awaited `run()` so the turn can report interrupted.
   */
  interruptForeground(signal: NodeJS.Signals = "SIGTERM"): number {
    let n = 0;
    for (const rec of this.procs.values()) {
      if (rec.running && !rec.background) {
        this.killTree(rec, signal);
        n++;
      }
    }
    this.activeForeground = null;
    return n;
  }

  /** Background processes (for the /bg panel). */
  listBackground(): Array<Pick<ProcRecord, "id" | "command" | "running" | "exitCode">> {
    return this.list().filter((p) => {
      const rec = this.procs.get(p.id);
      return rec?.background;
    });
  }

  killAll() {
    for (const rec of this.procs.values()) {
      if (rec.running) this.killTree(rec, "SIGTERM");
    }
  }
}

import { spawn, ChildProcess } from "node:child_process";

export interface ProcRecord {
  id: string;
  command: string;
  child: ChildProcess;
  background: boolean;
  startedAt: number;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  running: boolean;
  output: string[]; // ring buffer of combined stdout+stderr lines
  partial: string; // incomplete trailing line not yet terminated by \n
  detach?: () => void; // resolve the waiting fg call early, keep process alive
  notify: boolean; // on exit, wake the agent immediately (vs inject next turn)
}

export interface RunResult {
  id: string;
  background: boolean;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  output: string; // full captured output (fg) or initial snapshot (bg)
  timedOut: boolean;
  running: boolean;
}

const RING_MAX = 5000; // max lines kept per process

/**
 * Owns every child process the agent spawns. Foreground runs resolve on exit;
 * background runs return immediately and keep streaming into a ring buffer the
 * agent can poll, tail, or kill by id.
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
    const text = rec.partial + chunk.toString("utf8");
    const parts = text.split("\n");
    rec.partial = parts.pop() ?? "";
    for (const line of parts) rec.output.push(line);
    if (rec.output.length > RING_MAX) {
      rec.output.splice(0, rec.output.length - RING_MAX);
    }
  }

  private flush(rec: ProcRecord) {
    if (rec.partial.length > 0) {
      rec.output.push(rec.partial);
      rec.partial = "";
    }
  }

  run(opts: {
    command: string;
    cwd?: string;
    background?: boolean;
    timeoutMs?: number;
    notify?: boolean;
  }): Promise<RunResult> {
    const { command, cwd, background = false, timeoutMs = 120_000, notify = false } = opts;
    const id = this.nextId();
    const child = spawn(command, {
      cwd,
      shell: true,
      env: process.env,
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
      partial: "",
      notify,
    };
    this.procs.set(id, rec);

    child.stdout?.on("data", (c: Buffer) => this.push(rec, c));
    child.stderr?.on("data", (c: Buffer) => this.push(rec, c));

    const settle = new Promise<{ timedOut: boolean; detached: boolean }>((resolve) => {
      let timer: NodeJS.Timeout | undefined;
      let timedOut = false;
      let done = false;
      const finish = (r: { timedOut: boolean; detached: boolean }) => {
        if (done) return;
        done = true;
        if (timer) clearTimeout(timer);
        resolve(r);
      };
      if (!background && timeoutMs > 0) {
        timer = setTimeout(() => {
          timedOut = true;
          child.kill("SIGTERM");
        }, timeoutMs);
      }
      // Ctrl+B path: resolve the waiting fg call now but leave the process running.
      rec.detach = () => {
        rec.background = true;
        finish({ timedOut: false, detached: true });
      };
      child.on("exit", (code, signal) => {
        rec.running = false;
        rec.exitCode = code;
        rec.signal = signal;
        this.flush(rec);
        if (this.activeForeground === id) this.activeForeground = null;
        if (rec.background) this.onBackgroundExit?.(rec); // includes detached jobs
        finish({ timedOut, detached: false });
      });
      child.on("error", (err) => {
        rec.running = false;
        this.push(rec, Buffer.from(`spawn error: ${err.message}`));
        if (this.activeForeground === id) this.activeForeground = null;
        finish({ timedOut, detached: false });
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
          });
        }, 150);
      });
    }

    this.activeForeground = id;
    return settle.then(({ timedOut, detached }) => {
      if (this.activeForeground === id) this.activeForeground = null;
      return {
        id,
        background: detached, // detached fg job reports as background
        exitCode: rec.exitCode,
        signal: rec.signal,
        output: rec.output.join("\n"),
        timedOut,
        running: rec.running,
      };
    });
  }

  tail(id: string, lines = 50): string | null {
    const rec = this.procs.get(id);
    if (!rec) return null;
    const all = rec.partial ? [...rec.output, rec.partial] : rec.output;
    return all.slice(-lines).join("\n");
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
    return rec.child.kill(signal);
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
        rec.child.kill(signal);
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
      if (rec.running) rec.child.kill("SIGTERM");
    }
  }
}

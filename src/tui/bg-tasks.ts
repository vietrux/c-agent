import { Text, type TUI } from "@earendil-works/pi-tui";
import { t } from "./themes.js";
import { notice, noteBlock } from "./components.js";
import { ListSelector, type RewindItem } from "./selector.js";
import type { TranscriptView } from "./transcript.js";
import type { BottomSlot } from "./bottom-slot.js";
import type { Agent, AgentEvents } from "../agent.js";
import type { ProcessManager, ProcRecord } from "../process/manager.js";
import type { SubagentManager, SubRecord } from "../subagent/manager.js";

/** The slice of App the background-task orchestrator drives. */
export interface BgHost {
  busy: boolean;
  status: string;
  view: TranscriptView;
  slot: BottomSlot;
  tui: TUI;
  agent: Agent;
  pm: ProcessManager;
  subMgr: SubagentManager;
  events(): AgentEvents;
}

/**
 * Owns background-task completions: the pending-completion queue and the
 * notify-driven autonomous drain. notify=true wakes the agent now; notify=false
 * rides along on the next user turn.
 */
export class BgTasks {
  private queue: { content: string; notify: boolean }[] = [];
  private drainPending = false; // a notify drain was requested while busy

  constructor(private host: BgHost) {}

  /** Ctrl+B: background the running foreground command, wake the agent when done. */
  backgroundCurrent(): void {
    const id = this.host.pm.backgroundActive(true); // notify
    this.host.view.addSpaced(
      notice(
        id
          ? `⤓ [${id}] moved to background — you'll be notified and the agent will act when it finishes`
          : "no foreground task to background",
      ),
    );
  }

  /** Fired by ProcessManager when a backgrounded process exits. */
  onExit(rec: ProcRecord): void {
    const status = rec.exitCode === 0 ? "ok" : `exit=${rec.exitCode ?? "?"}`;
    const tail = this.host.pm.tail(rec.id, 5) ?? "";
    this.host.view.addSpaced(
      notice(`✓ background [${rec.id}] finished (${status}): ${rec.command}`),
    );
    this.queue.push({
      content:
        `Background task [${rec.id}] \`${rec.command}\` finished (${status}).` +
        (tail ? `\nLast output:\n${tail}` : "") +
        (rec.logPath ? `\nFull output log: ${rec.logPath}` : ""),
      notify: rec.notify,
    });
    if (rec.notify) this.scheduleDrain();
    this.host.tui.requestRender();
  }

  /** Fired by SubagentManager when a background subagent settles. Always wakes
   * the agent (notify) so it can act on the subagent's result. */
  onSubagentExit(rec: SubRecord): void {
    const status = rec.status === "done" ? "ok" : rec.status;
    this.host.view.addSpaced(
      notice(`✓ subagent [${rec.id}] ${rec.label} finished (${status})`),
    );
    this.queue.push({
      content:
        `Background subagent [${rec.id}] (${rec.label}) finished (${status}).` +
        (rec.result ? `\nResult:\n${rec.result}` : "") +
        (rec.error ? `\nError: ${rec.error}` : ""),
      notify: true,
    });
    this.scheduleDrain();
    this.host.tui.requestRender();
  }

  /** Drain every queued completion (notify + quiet) to ride along on a user turn. */
  drainForUserTurn(): string[] {
    const notes = this.queue.map((q) => q.content);
    this.queue = [];
    return notes;
  }

  /** True if a notify task is waiting (or finished mid-turn) → run a turn now. */
  shouldDrainAfterTurn(): boolean {
    return this.drainPending || this.queue.some((q) => q.notify);
  }

  /** A notify task finished: run the agent now, or right after the current turn. */
  private scheduleDrain(): void {
    if (this.host.busy) {
      this.drainPending = true;
      return;
    }
    void this.drainNotify();
  }

  /** Autonomous turn consuming the queued notify notes. */
  async drainNotify(): Promise<void> {
    const host = this.host;
    this.drainPending = false;
    const notes = this.queue.filter((q) => q.notify).map((q) => q.content);
    if (notes.length === 0) return;
    this.queue = this.queue.filter((q) => !q.notify); // keep quiet notes for next user turn
    if (!host.agent.model) return; // no model yet — leave for a user turn

    host.busy = true;
    host.slot.editor.disableSubmit = true;
    host.status = "thinking…";
    for (const c of notes) host.view.addSpaced(noteBlock(c));
    try {
      await host.agent.notifyRun(host.events(), notes);
    } catch (err: any) {
      host.view.setLoader(null);
      host.view.addBlock(
        new Text(t.error("agent error: " + (err?.message ?? String(err))), 1, 0),
      );
    } finally {
      host.busy = false;
      host.status = "ready";
      host.slot.editor.disableSubmit = false;
      host.tui.requestRender();
      // More notify tasks finished while we were running → drain again.
      if (this.shouldDrainAfterTurn()) void this.drainNotify();
    }
  }

  /** /bg: list background shells + subagents; Enter cancels a running one. */
  openPanel(): void {
    const host = this.host;
    // Unified row: a bg shell or a bg subagent, each cancellable by kind.
    type Row = { kind: "proc" | "sub"; id: string; running: boolean; cancel: () => boolean };
    const rows: { item: RewindItem; row: Row }[] = [];

    host.pm.listBackground().forEach((task) => {
      rows.push({
        item: {
          index: rows.length,
          label: task.command,
          subtitle: task.running
            ? `shell [${task.id}] running · Enter to cancel`
            : `shell [${task.id}] exited(${task.exitCode ?? "?"})`,
        },
        row: { kind: "proc", id: task.id, running: task.running, cancel: () => host.pm.kill(task.id) },
      });
    });
    host.subMgr.list().forEach((sub) => {
      const running = sub.status === "running";
      rows.push({
        item: {
          index: rows.length,
          label: `${sub.label}: ${sub.prompt.replace(/\s+/g, " ").slice(0, 50)}`,
          subtitle: running
            ? `subagent [${sub.id}] running · Enter to cancel`
            : `subagent [${sub.id}] ${sub.status}`,
        },
        row: { kind: "sub", id: sub.id, running, cancel: () => host.subMgr.kill(sub.id) },
      });
    });

    if (rows.length === 0) {
      host.view.addBlock(notice("no background tasks"));
      return;
    }
    const selector = new ListSelector(
      "Background tasks",
      "↑/↓ select · Enter cancel running · Esc close",
      rows.map((r) => r.item),
      (i) => {
        const { row } = rows[i];
        if (row.running && row.cancel()) {
          host.view.addBlock(notice(`✗ cancelled ${row.kind} [${row.id}]`));
        }
        host.slot.restore();
      },
      () => host.slot.restore(),
    );
    host.slot.swap(selector);
  }
}

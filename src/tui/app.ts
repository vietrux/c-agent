import {
  TUI,
  ProcessTerminal,
  Text,
  CombinedAutocompleteProvider,
  matchesKey,
  Key,
  type Terminal,
} from "@earendil-works/pi-tui";
import { t } from "./themes.js";
import { notice, noteBlock, UserMessage } from "./components.js";
import { RewindSelector, SessionSelector, ListSelector, type RewindItem } from "./selector.js";
import { PermissionPrompt } from "./permission.js";
import { AskPrompt } from "./prompts.js";
import { Footer } from "./footer.js";
import { randomUUID } from "node:crypto";
import { TranscriptView } from "./transcript.js";
import { BottomSlot } from "./bottom-slot.js";
import { ScrollView } from "./scroll-view.js";
import { ModelPicker, type ProviderEntry } from "./model-picker.js";
import { BgTasks } from "./bg-tasks.js";
import { handleCommand } from "./commands.js";
import { Agent, AgentEvents } from "../agent.js";
import type { ProcessManager } from "../process/manager.js";
import type { SubagentManager } from "../subagent/manager.js";
import { Session, stripInjected, type SessionData } from "../session.js";
import type { ConfirmRequest, ConfirmResult } from "../tools/registry.js";
import type { PermissionEngine } from "../permissions.js";
import { MODES } from "../permissions.js";
import type { FileCheckpointer } from "../checkpoint.js";
import type { SessionStore } from "../store.js";
import type { UndercoverState } from "../utils/redact.js";
import { loadHistory, pushHistory } from "../history.js";
import { loadPrefs, savePrefs } from "../prefs.js";

export type { ProviderEntry } from "./model-picker.js";

/**
 * Top-level TUI controller. Owns the domain objects (agent, session, engine,
 * process manager…) and the turn lifecycle, delegates all rendering to a
 * `TranscriptView` + `BottomSlot`, and hands the model picker, background-task
 * orchestration, and slash-command routing to dedicated collaborators. Fields
 * the collaborators read are public so they can satisfy their host interfaces.
 */
export class App {
  tui: TUI;
  view: TranscriptView;
  slot: BottomSlot;
  private scroll!: ScrollView; // wraps the transcript; only active in fullscreen

  private headerText: Text | null = null;
  private modelPicker: ModelPicker;
  private bgTasks: BgTasks;

  status = "ready";
  busy = false;
  private ctrlCAt = 0; // timestamp of last Ctrl+C — double-press within window exits
  private queuedSubmissions: string[] = [];

  /** Set by index.ts after connecting MCP servers, shown by /mcp. */
  mcpSummary = "no MCP servers configured";

  /** Active provider name, shown in the footer; updated when /model switches. */
  activeProviderName = "";

  constructor(
    public agent: Agent,
    public session: Session,
    private engine: PermissionEngine,
    private checkpointer: FileCheckpointer,
    private undercover: UndercoverState,
    public pm: ProcessManager,
    public subMgr: SubagentManager,
    public providers: ProviderEntry[] = [],
    private store: SessionStore | null = null,
    terminal: Terminal = new ProcessTerminal(),
  ) {
    this.tui = new TUI(terminal);
    this.view = new TranscriptView(this.tui);
    this.slot = new BottomSlot(this.tui);
    this.modelPicker = new ModelPicker(this);
    this.bgTasks = new BgTasks(this);
  }

  /** AgentEvents bound to the view, mirroring the status string to the footer. */
  events(): AgentEvents {
    return this.view.events((s) => {
      this.status = s ?? "ready";
    });
  }

  // ---- tool-facing prompts (exposed to the registry) ----------------------

  /** Approve/deny a risky tool call via an in-flow prompt. */
  confirm = (req: ConfirmRequest): Promise<ConfirmResult> =>
    this.slot.exclusive(
      () =>
        new Promise<ConfirmResult>((resolve) => {
          const prompt = new PermissionPrompt(req, (r) => {
            this.slot.restore();
            resolve(r);
          });
          this.slot.swap(prompt);
        }),
    );

  getConfirm() {
    return this.confirm;
  }

  /** Prompt in the editor slot for the ask_user tool, resolve on submit. */
  ask = (question: string): Promise<string> =>
    this.slot.exclusive(
      () =>
        new Promise<string>((resolve) => {
          const prompt = new AskPrompt(question, (answer) => {
            this.slot.restore();
            resolve(answer.trim());
          });
          this.slot.swap(prompt);
        }),
    );

  getAsk() {
    return this.ask;
  }

  /** Live progress line (e.g. subagent tool activity) as a dim nested notice. */
  getMonitor() {
    return (line: string) => {
      this.view.addSpaced(notice(line));
      this.tui.requestRender();
    };
  }

  // ---- input / commands ---------------------------------------------------

  private async submit(text: string, fromQueue = false) {
    const trimmed = text.trim();
    if (!trimmed) return;
    this.scroll?.toBottom(); // a new message returns the view to the latest line
    // Record every submission for bash-style up/down recall (incl. slash cmds).
    if (!fromQueue) {
      this.slot.editor.addToHistory(trimmed);
      pushHistory(trimmed);
    }
    if (trimmed.startsWith("/")) {
      handleCommand(this, trimmed);
      return;
    }
    if (this.busy) {
      this.queuedSubmissions.push(trimmed);
      this.view.addSpaced(
        notice(`queued message (${this.queuedSubmissions.length} waiting)`),
      );
      this.tui.requestRender();
      return;
    }
    if (!this.agent.model) {
      this.view.addBlock(notice("pick a model first — use /model"));
      return;
    }
    this.busy = true;
    this.slot.editor.disableSubmit = true;
    this.status = "thinking…";

    // One stable id ties this turn's UI blocks to its session checkpoint.
    const turnId = randomUUID();
    this.view.markTurnStart(turnId);

    // Any queued bg completions (notify or quiet) ride along as their own
    // context notes/blocks, separate from the user's message.
    const notes = this.bgTasks.drainForUserTurn();
    for (const c of notes) this.view.addSpaced(noteBlock(c));
    this.view.addSpaced(new UserMessage(trimmed));

    try {
      await this.agent.run(trimmed, this.events(), notes, turnId);
    } catch (err: any) {
      this.view.setLoader(null);
      this.view.addBlock(
        new Text(t.error("agent error: " + (err?.message ?? String(err))), 1, 0),
      );
    } finally {
      this.busy = false;
      this.status = "ready";
      this.slot.editor.disableSubmit = false;
      this.tui.requestRender();
      const next = this.queuedSubmissions.shift();
      if (next) {
        this.view.addSpaced(
          notice(
            this.queuedSubmissions.length > 0
              ? `running queued message (${this.queuedSubmissions.length} still waiting)`
              : "running queued message",
          ),
        );
        queueMicrotask(() => void this.submit(next, true));
      } else if (this.bgTasks.shouldDrainAfterTurn()) {
        // notify tasks that finished during this turn → run now.
        void this.bgTasks.drainNotify();
      }
    }
  }

  /** /model: hand off to the model picker. */
  pickModel(): void {
    void this.modelPicker.pick();
  }

  /** /bg: hand off to the background-task panel. */
  openBgTasks(): void {
    this.bgTasks.openPanel();
  }

  /** Advance to the next permission mode (Tab) — reflected in the status bar. */
  private cycleMode() {
    const i = MODES.indexOf(this.engine.mode);
    this.engine.mode = MODES[(i + 1) % MODES.length];
    this.tui.requestRender();
  }

  refreshHeader() {
    if (!this.headerText) return;
    this.headerText.setText(
      t.bold(t.accent("c-agent")) +
        t.dim(`  ${this.agent.model || "(no model)"}`) +
        "\n" +
        t.muted("type to chat") +
        t.dim("  ·  /help  ·  Tab: mode  ·  Ctrl+B: bg  ·  Ctrl+O/E: expand"),
    );
    this.tui.requestRender();
  }

  // ---- undercover / compaction --------------------------------------------

  setUndercover(arg: string) {
    const a = arg.toLowerCase();
    if (a === "on") this.undercover.enabled = true;
    else if (a === "off") this.undercover.enabled = false;
    else this.undercover.enabled = !this.undercover.enabled; // bare toggle
    const v = this.undercover.vault;
    this.view.addBlock(
      notice(
        this.undercover.enabled
          ? `🕶 undercover ON — PII masked before reaching the model (${v.size} values vaulted, id ${v.sessId})`
          : "undercover OFF — model sees raw text",
      ),
    );
    this.tui.requestRender();
  }

  async runCompact() {
    if (this.busy) {
      this.view.addBlock(notice("can't compact while the agent is working"));
      return;
    }
    if (this.session.checkpoints.length <= 1) {
      this.view.addBlock(notice("nothing to compact"));
      return;
    }
    this.busy = true;
    try {
      const did = await this.agent.compact(this.events());
      if (!did) this.view.addBlock(notice("compaction skipped"));
    } finally {
      this.busy = false;
      this.tui.requestRender();
    }
  }

  // ---- rewind / resume -----------------------------------------------------

  openRewind() {
    if (this.busy) {
      this.view.addBlock(notice("can't rewind while the agent is working"));
      return;
    }
    if (this.session.checkpoints.length === 0) {
      this.view.addBlock(notice("nothing to rewind"));
      return;
    }
    const items: RewindItem[] = this.session.checkpoints.map((cp, i) => {
      // Recompute from the full message (stored label may be a truncated wrapper).
      const msg = this.session.messages[cp.msgIndex];
      const raw = msg && msg.role === "user" ? msg.content : cp.label;
      const label = stripInjected(raw).replace(/\s+/g, " ").slice(0, 60);
      return {
        index: i,
        label: label || "(background update)",
        subtitle: `turn ${i + 1} of ${this.session.checkpoints.length}`,
      };
    });
    const selector = new RewindSelector(
      items,
      (i) => {
        // Resolve the selected row to its stable turn id, then drive both the
        // session and the view by that id — never by array position.
        const cp = this.session.checkpoints[i];
        if (!cp) return;
        this.checkpointer.restoreTo(cp.fileMark); // undo file edits from this turn on
        const start = this.view.turnStartAt(cp.id);
        if (start !== undefined) this.view.removeFrom(start);
        this.view.truncateTurns(cp.id);
        const text = this.session.rewindTo(cp.id);
        this.slot.restore();
        // Restore the user's text WITHOUT the system-injected blocks (hook
        // context, bg updates) — those are re-added on the next submit; leaking
        // them into the editor would double-inject on resend.
        const editable = text ? stripInjected(text) : "";
        if (editable) this.slot.editor.setText(editable);
      },
      () => this.slot.restore(),
    );
    this.slot.swap(selector);
  }

  /** Start a fresh conversation, keeping the current one saved & resumable. */
  newConversation() {
    if (this.busy) {
      this.view.addBlock(notice("can't start a new conversation while the agent is working"));
      return;
    }
    const next = new Session(this.session.cwd);
    this.store?.attach(next); // re-point autosave at the new session
    this.agent.setSession(next);
    this.session = next;
    this.checkpointer.clear(); // file undo log belongs to the old session
    this.view.clear();
    this.view.addSpaced(notice("✦ new conversation"));
    this.tui.requestRender();
  }

  openResume() {
    if (this.busy) {
      this.view.addBlock(notice("can't resume while the agent is working"));
      return;
    }
    if (!this.store) {
      this.view.addBlock(notice("session store unavailable"));
      return;
    }
    const show = () => {
      const sessions = this.store!.list().filter((s) => s.id !== this.session.id);
      if (sessions.length === 0) {
        this.slot.restore();
        this.view.addBlock(notice("no other sessions for this project"));
        return;
      }
      const items: RewindItem[] = sessions.map((s, i) => ({
        index: i,
        label: s.title || "(untitled)",
        subtitle: `${fmtAgo(s.updatedAt)} · ${s.messages.length} messages`,
      }));
      const selector = new SessionSelector(
        items,
        (i) => {
          this.slot.restore();
          this.switchSession(sessions[i]);
        },
        () => this.slot.restore(),
        (i) => this.confirmDeleteSession(sessions[i], show),
      );
      this.slot.swap(selector);
    };
    show();
  }

  /** Confirm + delete a stored session, then re-render the resume picker. */
  private confirmDeleteSession(s: SessionData, back: () => void) {
    const name = (s.title || "(untitled)").slice(0, 60);
    const confirm = new ListSelector(
      "Delete session?",
      `"${name}" — can't be undone. ↑/↓ select · Enter confirm · Esc cancel`,
      [
        { index: 0, label: "Cancel" },
        { index: 1, label: "Delete" },
      ],
      (i) => {
        if (i === 1) this.store?.delete(s.id);
        back();
      },
      () => back(),
      "first",
    );
    this.slot.swap(confirm);
  }

  /** Replace the live transcript with a stored one and re-render it. */
  private switchSession(data: SessionData) {
    const next = Session.fromData(data);
    this.store?.attach(next); // re-point autosave at the resumed session
    this.agent.setSession(next);
    this.session = next;
    this.checkpointer.clear(); // file undo log belongs to the old session
    this.view.clear();
    if (next.messages.length > 0) this.view.renderHistory(next);
    this.view.addSpaced(notice(`↻ resumed: ${next.title || next.id}`));
    this.tui.requestRender();
  }

  // ---- fullscreen (alternate screen buffer) -------------------------------

  /** True while the TUI owns the alternate screen buffer. */
  fullscreen = false;
  /** Renderer diff-state captured on entry, restored on exit for a seamless toggle. */
  private savedRender: Record<string, unknown> | null = null;
  private altExitHooked = false;

  /**
   * /fullscreen [on|off]: take over the whole terminal via the alternate screen
   * buffer (like vim/less/htop), or hand it back. A bare `/fullscreen` toggles.
   * The choice is persisted and re-applied on the next launch.
   */
  toggleFullscreen(arg = ""): void {
    const a = arg.toLowerCase().trim();
    const want = a === "on" ? true : a === "off" ? false : !this.fullscreen;
    if (want === this.fullscreen) {
      this.view.addBlock(notice(`fullscreen already ${want ? "on" : "off"}`));
      this.tui.requestRender();
    } else {
      this.applyFullscreen(want);
    }
    savePrefs({ fullscreen: want }); // remember for future sessions
  }

  /** Enter or leave the alt screen and redraw. Shared by the command and startup. */
  applyFullscreen(on: boolean): void {
    // pi-tui's render bookkeeping is private; reaching it is the price of
    // bolting an alt-screen mode onto an inline renderer.
    const r = this.tui as unknown as Record<string, unknown>;
    if (on) {
      if (this.fullscreen) return;
      // Capture exactly the fields requestRender(true) is about to reset, so
      // leaving fullscreen can resume the inline transcript instead of redrawing
      // over the user's shell scrollback.
      this.savedRender = {
        previousLines: r.previousLines,
        previousWidth: r.previousWidth,
        previousHeight: r.previousHeight,
        cursorRow: r.cursorRow,
        hardwareCursorRow: r.hardwareCursorRow,
        maxLinesRendered: r.maxLinesRendered,
        previousViewportTop: r.previousViewportTop,
        previousKittyImageIds: r.previousKittyImageIds,
      };
      this.tui.terminal.write("\x1b[?1049h"); // enter alt buffer (saves cursor)
      this.fullscreen = true;
      this.scroll.enabled = true; // window the transcript (no native scrollback here)
      this.scroll.toBottom();
      this.ensureAltExitHook();
      this.view.addBlock(
        notice("⛶ fullscreen on — PgUp/PgDn to scroll · /fullscreen off to exit"),
      );
      this.tui.requestRender(true); // clean full render at the top of the alt buffer
    } else {
      this.scroll.enabled = false; // back to inline pass-through + native scrollback
      this.leaveAltScreen();
      if (this.savedRender) {
        Object.assign(r, this.savedRender); // realign diffing with the restored buffer
        this.savedRender = null;
      }
      this.tui.requestRender(); // append anything that arrived while fullscreen
    }
  }

  /** Switch back to the normal screen buffer if we own the alt one. Idempotent. */
  leaveAltScreen(): void {
    if (!this.fullscreen) return;
    this.tui.terminal.write("\x1b[?1049l"); // restore normal buffer + cursor
    this.fullscreen = false;
  }

  /** Safety net: never strand the user in the alt buffer if the process dies. */
  private ensureAltExitHook(): void {
    if (this.altExitHooked) return;
    this.altExitHooked = true;
    process.on("exit", () => {
      if (this.fullscreen) process.stdout.write("\x1b[?1049l");
    });
  }

  // ---- lifecycle ----------------------------------------------------------

  start() {
    this.headerText = new Text(
      t.bold(t.accent("c-agent")) +
        t.dim(`  ${this.agent.model || "(no model)"}`) +
        "\n" +
        t.muted("type to chat") +
        t.dim("  ·  /help  ·  Tab: mode  ·  Ctrl+B: bg  ·  Ctrl+O/E: expand"),
      1,
      0,
    );
    this.view.mountHeader(this.headerText);
    this.slot.editor.setAutocompleteProvider(
      new CombinedAutocompleteProvider(
        [
          {
            name: "resume",
            description: "Load a previous session for this project",
          },
          {
            name: "rewind",
            description: "Roll back to an earlier message (restores files)",
          },
          {
            name: "compact",
            description: "Summarize older turns to free context",
          },
          {
            name: "model",
            description: "Pick the model from the provider's list",
          },
          {
            name: "effort",
            description: "Set reasoning effort (minimal…max)",
          },
          {
            name: "undercover",
            description: "Toggle PII masking before sending to the model",
          },
          {
            name: "fullscreen",
            description: "Full-screen TUI on/off (remembered next launch)",
          },
          { name: "bg", description: "List/cancel background tasks" },
          { name: "mcp", description: "Show MCP server status" },
          { name: "context", description: "Show context token usage" },
          { name: "new", description: "Start a new conversation" },
          { name: "help", description: "List commands" },
          { name: "exit", description: "Quit" },
        ],
        process.cwd(),
      ),
    );
    this.slot.editor.onSubmit = (text) => void this.submit(text);
    for (const h of loadHistory()) this.slot.editor.addToHistory(h); // oldest→newest
    this.pm.onBackgroundExit = (rec) => this.bgTasks.onExit(rec);
    this.subMgr.onExit = (rec) => this.bgTasks.onSubagentExit(rec);

    if (this.session.messages.length > 0) this.view.renderHistory(this.session);

    const footer = new Footer({
      status: () => this.status,
      model: () => this.agent.model,
      provider: () => this.activeProviderName,
      mode: () => this.engine.mode,
      undercover: () => this.undercover.enabled,
      turns: () => this.session.checkpoints.length,
      cwd: () => process.cwd(),
      usage: () => this.agent.lastUsage,
      context: () => ({
        used: this.agent.contextTokens(),
        limit: this.agent.contextLimit(),
      }),
      effort: () => this.agent.currentEffort(),
    });

    // layout (top → bottom). Editor draws its own top/bottom borders.
    // In fullscreen the transcript is windowed by ScrollView (the alt screen has
    // no native scrollback); inline, it's a pass-through. The reserve fn measures
    // the editor + footer live so the window always sizes to the rows above them.
    this.scroll = new ScrollView(
      this.view.container,
      this.tui,
      (w) => this.slot.container.render(w).length + footer.render(w).length,
    );
    this.tui.addChild(this.scroll);
    this.tui.addChild(this.slot.container);
    this.tui.addChild(footer);

    this.slot.focusEditor();
    this.tui.addInputListener((data) => {
      if (matchesKey(data, Key.ctrl("c"))) {
        const now = Date.now();
        if (now - this.ctrlCAt < 2000) {
          this.leaveAltScreen();
          this.tui.stop();
          process.exit(0);
        }
        this.ctrlCAt = now;
        if (this.busy) this.agent.abort(); // first press also interrupts any in-flight turn
        this.view.addBlock(notice("press Ctrl+C again to exit"));
        return { consume: true };
      }
      // Fullscreen scrolling: the alt screen has no native scrollback, so PgUp/
      // PgDn (and Shift+↑/↓ for fine steps) move a window over the transcript.
      // End jumps back to the latest line; only grabbed while actually scrolled
      // up so the editor keeps End at the bottom.
      if (this.fullscreen) {
        if (matchesKey(data, Key.pageUp)) {
          this.scroll.scrollByPage(1);
          return { consume: true };
        }
        if (matchesKey(data, Key.pageDown)) {
          this.scroll.scrollByPage(-1);
          return { consume: true };
        }
        if (matchesKey(data, Key.shift("up"))) {
          this.scroll.scrollByLines(1);
          return { consume: true };
        }
        if (matchesKey(data, Key.shift("down"))) {
          this.scroll.scrollByLines(-1);
          return { consume: true };
        }
        if (this.scroll.scrolledUp && matchesKey(data, Key.end)) {
          this.scroll.toBottom();
          return { consume: true };
        }
      }
      // Tab cycles permission mode — but only at an empty editor, so it doesn't
      // steal Tab from autocomplete while typing a command.
      if (
        this.slot.isAtEditor &&
        !this.busy &&
        matchesKey(data, Key.tab) &&
        this.slot.editor.getText().length === 0
      ) {
        this.cycleMode();
        return { consume: true };
      }
      // Ctrl+B: background the running foreground command.
      if (this.busy && matchesKey(data, Key.ctrl("b"))) {
        this.bgTasks.backgroundCurrent();
        return { consume: true };
      }
      // Ctrl+O / Ctrl+E: expand full tool output / thinking (view toggles, any time).
      if (matchesKey(data, Key.ctrl("o"))) {
        this.view.toggleToolOutputs();
        return { consume: true };
      }
      if (matchesKey(data, Key.ctrl("e"))) {
        this.view.toggleReasoning();
        return { consume: true };
      }
      // Tab: accept an open autocomplete suggestion; otherwise cycle mode.
      if (this.slot.isAtEditor && matchesKey(data, Key.tab)) {
        if (this.slot.editor.isShowingAutocomplete()) return undefined; // let editor complete
        this.cycleMode();
        return { consume: true };
      }
      // Esc aborts an in-flight turn, but only at the editor — a prompt/selector
      // handles its own Esc (deny / cancel).
      if (this.busy && this.slot.isAtEditor && matchesKey(data, Key.escape)) {
        this.agent.abort();
        return { consume: true };
      }
      return undefined;
    });
    this.tui.start();

    // Restore the persisted fullscreen choice from a previous session.
    if (loadPrefs().fullscreen) this.applyFullscreen(true);

    // No model configured → prompt the user to pick one before chatting.
    if (!this.agent.model) {
      this.view.addBlock(notice("no model configured — choose one to start"));
      this.pickModel();
    }
  }
}

function fmtAgo(ts: number): string {
  const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

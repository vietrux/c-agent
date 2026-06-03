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
import {
  RewindSelector,
  SessionSelector,
  ModelSelector,
  ListSelector,
  type RewindItem,
} from "./selector.js";
import { PermissionPrompt } from "./permission.js";
import { AskPrompt } from "./prompts.js";
import { Footer } from "./footer.js";
import { TranscriptView } from "./transcript.js";
import { BottomSlot } from "./bottom-slot.js";
import { Agent, AgentEvents } from "../agent.js";
import type { Provider } from "../provider/types.js";
import type { ProcessManager, ProcRecord } from "../process/manager.js";
import { Session, stripInjected, type SessionData } from "../session.js";
import type { Decision } from "../tools/registry.js";
import type { PermissionEngine } from "../permissions.js";
import { MODES } from "../permissions.js";
import type { FileCheckpointer } from "../checkpoint.js";
import type { SessionStore } from "../store.js";
import type { UndercoverState } from "../utils/redact.js";
import { savePrefs } from "../prefs.js";

export interface ProviderEntry {
  name: string;
  provider: Provider;
}

/**
 * Top-level TUI controller. Owns the domain objects (agent, session, engine,
 * process manager…) and the turn lifecycle, and delegates all rendering to a
 * `TranscriptView` (the scrolling block list) and a `BottomSlot` (editor +
 * transient selectors/prompts).
 */
export class App {
  private tui: TUI;
  private view: TranscriptView;
  private slot: BottomSlot;

  private headerText: Text | null = null;
  // bg-task completions awaiting delivery. notify=true wakes the agent now;
  // notify=false rides along on the next user turn.
  private bgQueue: { content: string; notify: boolean }[] = [];
  private drainPending = false; // a notify drain was requested while busy
  private status = "ready";
  private busy = false;
  private ctrlCAt = 0; // timestamp of last Ctrl+C — double-press within window exits

  /** Set by index.ts after connecting MCP servers, shown by /mcp. */
  mcpSummary = "no MCP servers configured";

  /** Active provider name, shown in the footer; updated when /model switches. */
  activeProviderName = "";

  constructor(
    private agent: Agent,
    private session: Session,
    private engine: PermissionEngine,
    private checkpointer: FileCheckpointer,
    private undercover: UndercoverState,
    private pm: ProcessManager,
    private providers: ProviderEntry[] = [],
    private store: SessionStore | null = null,
    terminal: Terminal = new ProcessTerminal(),
  ) {
    this.tui = new TUI(terminal);
    this.view = new TranscriptView(this.tui);
    this.slot = new BottomSlot(this.tui);
  }

  /** AgentEvents bound to the view, mirroring the status string to the footer. */
  private events(): AgentEvents {
    return this.view.events((s) => {
      this.status = s ?? "ready";
    });
  }

  // ---- tool-facing prompts (exposed to the registry) ----------------------

  /** Approve/deny a risky tool call via an in-flow prompt. */
  confirm = (req: { name: string; preview: string }): Promise<Decision> =>
    this.slot.exclusive(
      () =>
        new Promise<Decision>((resolve) => {
          const prompt = new PermissionPrompt(req.name, req.preview, (d) => {
            this.slot.restore();
            resolve(d);
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

  // ---- input / commands ---------------------------------------------------

  private async submit(text: string) {
    const trimmed = text.trim();
    if (!trimmed) return;
    if (trimmed.startsWith("/")) {
      this.handleCommand(trimmed);
      return;
    }
    if (this.busy) return;
    if (!this.agent.model) {
      this.view.addBlock(notice("pick a model first — use /model"));
      return;
    }
    this.busy = true;
    this.slot.editor.disableSubmit = true;
    this.status = "thinking…";

    this.view.markTurnStart();

    // Any queued bg completions (notify or quiet) ride along as their own
    // context notes/blocks, separate from the user's message.
    const notes = this.bgQueue.map((q) => q.content);
    this.bgQueue = [];
    for (const c of notes) this.view.addSpaced(noteBlock(c));
    this.view.addSpaced(new UserMessage(trimmed));

    try {
      await this.agent.run(trimmed, this.events(), notes);
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
      // notify tasks that finished during this turn → run now.
      if (this.drainPending || this.bgQueue.some((q) => q.notify))
        void this.drainNotify();
    }
  }

  private handleCommand(line: string) {
    const [cmd, ...rest] = line.split(/\s+/);
    const arg = rest.join(" ").trim();
    switch (cmd) {
      case "/exit":
      case "/quit":
        this.tui.stop();
        process.exit(0);
        break;
      case "/clear":
        this.view.clear();
        this.session.clear();
        break;
      case "/rewind":
        this.openRewind();
        break;
      case "/resume":
        this.openResume();
        break;
      case "/compact":
        this.runCompact();
        break;
      case "/undercover":
        this.setUndercover(arg);
        break;
      case "/model":
        void this.pickModel();
        break;
      case "/bg":
        this.openBgTasks();
        break;
      case "/mcp":
        this.view.addBlock(notice(this.mcpSummary));
        break;
      case "/context":
        this.view.addBlock(
          notice(
            `~${this.agent.contextTokens().toLocaleString()} tokens · ${this.session.messages.length} messages`,
          ),
        );
        break;
      case "/help":
        this.view.addBlock(
          notice(
            "/resume  /rewind  /compact  /model  /undercover [on|off]  /bg  /mcp  /context  /clear  /exit  ·  Tab: mode · Ctrl+B: background · Ctrl+O/E: expand",
          ),
        );
        break;
      default:
        this.view.addBlock(notice(`unknown command: ${cmd}`));
    }
  }

  // ---- background tasks ----------------------------------------------------

  /** Ctrl+B: background the running foreground command and wake the agent when done. */
  private backgroundCurrent() {
    const id = this.pm.backgroundActive(true); // notify
    this.view.addSpaced(
      notice(
        id
          ? `⤓ [${id}] moved to background — you'll be notified and the agent will act when it finishes`
          : "no foreground task to background",
      ),
    );
  }

  /** Fired by ProcessManager when a backgrounded process exits. */
  private onBackgroundExit(rec: ProcRecord) {
    const status = rec.exitCode === 0 ? "ok" : `exit=${rec.exitCode ?? "?"}`;
    const tail = this.pm.tail(rec.id, 5) ?? "";
    this.view.addSpaced(
      notice(`✓ background [${rec.id}] finished (${status}): ${rec.command}`),
    );
    this.bgQueue.push({
      content:
        `Background task [${rec.id}] \`${rec.command}\` finished (${status}).` +
        (tail ? `\nLast output:\n${tail}` : ""),
      notify: rec.notify,
    });
    if (rec.notify) this.scheduleDrain();
    this.tui.requestRender();
  }

  /** A notify task finished: run the agent now, or right after the current turn. */
  private scheduleDrain() {
    if (this.busy) {
      this.drainPending = true;
      return;
    }
    void this.drainNotify();
  }

  /** Autonomous turn consuming the queued notify notes. */
  private async drainNotify() {
    this.drainPending = false;
    const notes = this.bgQueue.filter((q) => q.notify).map((q) => q.content);
    if (notes.length === 0) return;
    this.bgQueue = this.bgQueue.filter((q) => !q.notify); // keep quiet notes for next user turn
    if (!this.agent.model) return; // no model yet — leave for a user turn

    this.busy = true;
    this.slot.editor.disableSubmit = true;
    this.status = "thinking…";
    for (const c of notes) this.view.addSpaced(noteBlock(c));
    try {
      await this.agent.notifyRun(this.events(), notes);
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
      // More notify tasks finished while we were running → drain again.
      if (this.drainPending || this.bgQueue.some((q) => q.notify))
        void this.drainNotify();
    }
  }

  /** /bg: list background tasks; Enter cancels a running one. */
  private openBgTasks() {
    const tasks = this.pm.listBackground();
    if (tasks.length === 0) {
      this.view.addBlock(notice("no background tasks"));
      return;
    }
    const items: RewindItem[] = tasks.map((task, i) => ({
      index: i,
      label: task.command,
      subtitle: task.running
        ? `[${task.id}] running · Enter to cancel`
        : `[${task.id}] exited(${task.exitCode ?? "?"})`,
    }));
    const selector = new ListSelector(
      "Background tasks",
      "↑/↓ select · Enter cancel running · Esc close",
      items,
      (i) => {
        const task = tasks[i];
        if (task.running && this.pm.kill(task.id)) {
          this.view.addBlock(notice(`✗ cancelled [${task.id}]`));
        }
        this.slot.restore();
      },
      () => this.slot.restore(),
    );
    this.slot.swap(selector);
  }

  /** Advance to the next permission mode (Tab) — reflected in the status bar. */
  private cycleMode() {
    const i = MODES.indexOf(this.engine.mode);
    this.engine.mode = MODES[(i + 1) % MODES.length];
    this.tui.requestRender();
  }

  // ---- model picker --------------------------------------------------------

  /** Fetch models from every configured provider and let the user pick. */
  private async pickModel() {
    if (this.busy) {
      this.view.addBlock(notice("can't switch model while the agent is working"));
      return;
    }
    const entries = this.providers;
    this.view.setLoader("listing models…");
    const lists = await Promise.all(
      entries.map((e) =>
        (e.provider.listModels ? e.provider.listModels() : Promise.resolve([])).then(
          (models) => models,
          () => [] as string[],
        ),
      ),
    );
    this.view.setLoader(null);

    // Flat, searchable list; each row labelled `model (Provider)`. A provider
    // whose list endpoint is empty/unavailable still appears: it falls back to
    // its configured model, or a "type a model id" row so it stays selectable.
    const items: RewindItem[] = [];
    const choices: { entry: ProviderEntry; model: string | null }[] = [];
    entries.forEach((entry, gi) => {
      let models = lists[gi];
      if (models.length === 0 && entry.provider.model) models = [entry.provider.model];
      const pp = prettyProvider(entry.name);
      if (models.length === 0) {
        const ci = choices.length;
        choices.push({ entry, model: null }); // manual entry
        items.push({ index: ci, label: `⌨ enter a model id… (${pp})` });
        return;
      }
      for (const model of models) {
        const ci = choices.length;
        choices.push({ entry, model });
        items.push({ index: ci, label: `${model} (${pp})` });
      }
    });

    if (choices.length === 0) {
      this.view.addBlock(
        notice("no providers available — check ~/.c-agent/settings.json"),
      );
      return;
    }

    const selector = new ModelSelector(
      items,
      (i) => {
        const { entry, model } = choices[i];
        this.slot.restore();
        if (model === null) this.promptModelId(entry);
        else this.applyModel(entry, model);
      },
      () => this.slot.restore(),
    );
    this.slot.swap(selector);
  }

  /** Switch to a provider+model, persist the choice, refresh UI. */
  private applyModel(entry: ProviderEntry, model: string) {
    this.agent.swapProvider(entry.provider);
    this.agent.setModel(model);
    this.activeProviderName = entry.name;
    savePrefs({ lastProvider: entry.name, lastModel: model });
    this.refreshHeader();
    this.tui.requestRender();
  }

  /** Ask for a model id when a provider exposes no model list. */
  private promptModelId(entry: ProviderEntry) {
    const prompt = new AskPrompt(`model id for ${prettyProvider(entry.name)}`, (answer) => {
      this.slot.restore();
      const id = answer.trim();
      if (id) this.applyModel(entry, id);
    });
    this.slot.swap(prompt);
  }

  private refreshHeader() {
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

  private setUndercover(arg: string) {
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

  private async runCompact() {
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

  private openRewind() {
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
        const cp = this.session.checkpoints[i];
        if (cp) this.checkpointer.restoreTo(cp.fileMark); // undo file edits from this turn on
        const text = this.session.rewindTo(i);
        const start = this.view.turnStartAt(i);
        if (start !== undefined) this.view.removeFrom(start);
        this.view.truncateTurns(i);
        this.slot.restore();
        if (text) this.slot.editor.setText(text);
      },
      () => this.slot.restore(),
    );
    this.slot.swap(selector);
  }

  private openResume() {
    if (this.busy) {
      this.view.addBlock(notice("can't resume while the agent is working"));
      return;
    }
    if (!this.store) {
      this.view.addBlock(notice("session store unavailable"));
      return;
    }
    const sessions = this.store.list().filter((s) => s.id !== this.session.id);
    if (sessions.length === 0) {
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
    );
    this.slot.swap(selector);
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
            name: "undercover",
            description: "Toggle PII masking before sending to the model",
          },
          { name: "bg", description: "List/cancel background tasks" },
          { name: "mcp", description: "Show MCP server status" },
          { name: "context", description: "Show context token usage" },
          { name: "clear", description: "Clear the conversation" },
          { name: "help", description: "List commands" },
          { name: "exit", description: "Quit" },
        ],
        process.cwd(),
      ),
    );
    this.slot.editor.onSubmit = (text) => void this.submit(text);
    this.pm.onBackgroundExit = (rec) => this.onBackgroundExit(rec);

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
    });

    // layout (top → bottom). Editor draws its own top/bottom borders.
    this.tui.addChild(this.view.container);
    this.tui.addChild(this.slot.container);
    this.tui.addChild(footer);

    this.slot.focusEditor();
    this.tui.addInputListener((data) => {
      if (matchesKey(data, Key.ctrl("c"))) {
        const now = Date.now();
        if (now - this.ctrlCAt < 2000) {
          this.tui.stop();
          process.exit(0);
        }
        this.ctrlCAt = now;
        if (this.busy) this.agent.abort(); // first press also interrupts any in-flight turn
        this.view.addBlock(notice("press Ctrl+C again to exit"));
        return { consume: true };
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
        this.backgroundCurrent();
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

    // No model configured → prompt the user to pick one before chatting.
    if (!this.agent.model) {
      this.view.addBlock(notice("no model configured — choose one to start"));
      void this.pickModel();
    }
  }
}

const PROVIDER_LABELS: Record<string, string> = {
  anthropic: "Anthropic",
  openai: "OpenAI",
  nim: "NIM",
  openrouter: "OpenRouter",
};
function prettyProvider(name: string): string {
  return (
    PROVIDER_LABELS[name.toLowerCase()] ??
    (name.length <= 4 ? name.toUpperCase() : name[0].toUpperCase() + name.slice(1))
  );
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

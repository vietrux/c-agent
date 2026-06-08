import {
  TUI,
  Markdown,
  Loader,
  Spacer,
  Container,
  type Component,
} from "@earendil-works/pi-tui";
import { markdownTheme, t } from "./themes.js";
import {
  ReasoningBlock,
  ToolBlock,
  UserMessage,
  notice,
  noteBlock,
} from "./components.js";
import type { AgentEvents } from "../agent.js";
import { Session, stripInjected } from "../session.js";

function compactJson(v: any): string {
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

/**
 * Owns the scrolling transcript: the rendered block list, the live
 * assistant/reasoning/tool blocks streamed during a turn, the working loader,
 * and the turn→block-index map that `/rewind` and `/new` rely on. Knows
 * nothing about the agent, providers, or permission engine — it only renders.
 */
export class TranscriptView {
  readonly container = new Container();

  // tracked message blocks + the block index where each user turn began,
  // tagged with the turn's stable checkpoint id so /rewind matches on identity
  // (not array position) and can't desync from Session.checkpoints.
  private blocks: Component[] = [];
  private turns: { id: string; blockStart: number }[] = [];

  private loader: Loader | null = null;
  private liveAssistant: { md: Markdown; buf: string } | null = null;
  private liveReasoning: ReasoningBlock | null = null;
  private toolBlocks = new Map<string, ToolBlock>(); // tool id → block (parallel dispatch)

  private showReasoning = process.env.C_AGENT_SHOW_REASONING !== "0";
  private toolsExpanded = false; // Ctrl+O: full tool output
  private reasoningExpanded = false; // Ctrl+E: full thinking

  constructor(private tui: TUI) {}

  /** Add a persistent top element (the header) that block ops never touch. */
  mountHeader(comp: Component) {
    this.container.addChild(comp);
  }

  // ---- block helpers ------------------------------------------------------

  addBlock(comp: Component) {
    this.container.addChild(comp);
    this.blocks.push(comp);
    this.tui.requestRender();
  }

  /** Add a block with exactly one blank line above it (no double spacers). */
  addSpaced(comp: Component) {
    const last = this.blocks[this.blocks.length - 1];
    if (this.blocks.length > 0 && !(last instanceof Spacer)) {
      this.addBlock(new Spacer(1));
    }
    this.addBlock(comp);
  }

  removeFrom(blockIdx: number) {
    for (let i = this.blocks.length - 1; i >= blockIdx; i--) {
      this.container.removeChild(this.blocks[i]);
    }
    this.blocks.length = blockIdx;
    this.tui.requestRender();
  }

  setLoader(text: string | null) {
    if (text === null) {
      if (this.loader) {
        this.container.removeChild(this.loader);
        this.loader = null;
        this.tui.requestRender();
      }
      return;
    }
    if (!this.loader) {
      this.loader = new Loader(this.tui, t.accent, t.muted, text);
      this.container.addChild(this.loader);
      this.loader.start();
    } else {
      this.loader.setMessage(text);
    }
    this.tui.requestRender();
  }

  // ---- turn bookkeeping (for /rewind, /new) -------------------------------

  /** Mark the current block position as the start of the turn `id`. */
  markTurnStart(id: string) {
    this.turns.push({ id, blockStart: this.blocks.length });
  }

  /** Block index where turn `id` began, or undefined. */
  turnStartAt(id: string): number | undefined {
    return this.turns.find((t) => t.id === id)?.blockStart;
  }

  /** Drop turn `id` and every marker after it (rewind to that turn). */
  truncateTurns(id: string) {
    const i = this.turns.findIndex((t) => t.id === id);
    if (i >= 0) this.turns.length = i;
  }

  /** Forget all turn markers (history collapsed/cleared/resumed). */
  resetTurns() {
    this.turns.length = 0;
  }

  /** Clear every block and turn marker. */
  clear() {
    this.removeFrom(0);
    this.resetTurns();
  }

  // ---- view toggles -------------------------------------------------------

  /** Ctrl+O: toggle full tool output for every tool block. */
  toggleToolOutputs() {
    this.toolsExpanded = !this.toolsExpanded;
    for (const b of this.blocks)
      if (b instanceof ToolBlock) b.setExpanded(this.toolsExpanded);
    this.tui.requestRender();
  }

  /** Ctrl+E: toggle full thinking trace for every reasoning block. */
  toggleReasoning() {
    this.reasoningExpanded = !this.reasoningExpanded;
    for (const b of this.blocks)
      if (b instanceof ReasoningBlock) b.setExpanded(this.reasoningExpanded);
    this.tui.requestRender();
  }

  // ---- agent event sink ---------------------------------------------------

  /**
   * Translate streaming agent events into block mutations. `onStatus` lets the
   * owner mirror the status string into the footer (the only non-view concern).
   */
  events(onStatus: (s: string | null) => void): AgentEvents {
    return {
      reasoningDelta: (delta) => {
        if (!this.showReasoning) return;
        this.setLoader(null);
        if (!this.liveReasoning) {
          this.liveReasoning = new ReasoningBlock();
          this.liveReasoning.setExpanded(this.reasoningExpanded);
          this.addSpaced(this.liveReasoning);
        }
        this.liveReasoning.append(delta);
        this.tui.requestRender();
      },
      assistantDelta: (delta) => {
        this.setLoader(null);
        if (this.liveReasoning) {
          this.liveReasoning.finish();
          this.liveReasoning = null;
        }
        if (!this.liveAssistant) {
          const md = new Markdown("", 1, 0, markdownTheme);
          this.liveAssistant = { md, buf: "" };
          this.addSpaced(md);
        }
        this.liveAssistant.buf += delta;
        this.liveAssistant.md.setText(this.liveAssistant.buf);
        this.tui.requestRender();
      },
      assistantEnd: () => {
        this.liveAssistant = null;
        if (this.liveReasoning) {
          this.liveReasoning.finish();
          this.liveReasoning = null;
        }
      },
      toolStart: (id, name, input) => {
        this.setLoader(null);
        const arg =
          name === "bash" ? String(input.command ?? "") : compactJson(input);
        const tb = new ToolBlock(name, arg); // full body — never truncate the call
        tb.setExpanded(this.toolsExpanded);
        this.toolBlocks.set(id, tb);
        this.addSpaced(tb);
      },
      toolEnd: (id, result, isError) => {
        this.toolBlocks.get(id)?.setResult(result, isError);
        this.toolBlocks.delete(id);
        this.tui.requestRender();
      },
      status: (s) => {
        onStatus(s);
        this.setLoader(s);
      },
      interrupted: () => {
        this.setLoader(null);
        this.liveAssistant = null;
        if (this.liveReasoning) {
          this.liveReasoning.finish();
          this.liveReasoning = null;
        }
        this.addBlock(notice("⊘ interrupted"));
      },
      compacted: (note, collapsed) => {
        // Only a full compaction collapses history + drops checkpoints; reset the
        // turn markers to stay in sync. Micro-compaction leaves message/turn
        // structure intact, so wiping markers here would desync /rewind.
        if (collapsed) this.resetTurns();
        this.addSpaced(notice(`⊙ ${note}`));
      },
    };
  }

  // ---- history rebuild (resume) -------------------------------------------

  /** Rebuild on-screen blocks from a transcript so /rewind still works. */
  renderHistory(session: Session) {
    const idToBlock = new Map<string, ToolBlock>();
    let turn = 0;
    session.messages.forEach((m, idx) => {
      // A turn starts at its checkpoint msgIndex (the note, or the user message).
      const cp = session.checkpoints[turn];
      if (cp && cp.msgIndex === idx) {
        this.turns.push({ id: cp.id, blockStart: this.blocks.length });
        turn++;
      }
      if (m.role === "note") {
        this.addSpaced(noteBlock(m.content));
      } else if (m.role === "user") {
        this.addSpaced(new UserMessage(stripInjected(m.content)));
      } else if (m.role === "assistant") {
        if (m.content) this.addSpaced(new Markdown(m.content, 1, 0, markdownTheme));
        for (const tc of m.toolCalls) {
          const arg =
            tc.name === "bash"
              ? String(tc.input?.command ?? "")
              : compactJson(tc.input);
          const tb = new ToolBlock(tc.name, arg); // full body — never truncate the call
          tb.setExpanded(this.toolsExpanded);
          this.addSpaced(tb);
          idToBlock.set(tc.id, tb);
        }
      } else {
        for (const r of m.results)
          idToBlock.get(r.id)?.setResult(r.content, r.isError);
      }
    });
    this.addSpaced(notice("— resumed session —"));
  }
}

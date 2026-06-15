import {
  Box,
  Container,
  Markdown,
  Spacer,
  Text,
  truncateToWidth,
  type Component,
} from "@earendil-works/pi-tui";
import { t, markdownTheme } from "./themes.js";
import type { ToolEventInfo } from "../tools/scheduler.js";

/**
 * Strip bytes that desync pi-tui's differential renderer. External output
 * (curl -v, router JSON over HTTP, build logs) carries embedded ANSI escape
 * sequences, OSC/DCS strings, and C0 control chars — including bare CR and
 * cursor moves. pi-tui computes each line's display width assuming plain text,
 * so these bytes shift the real cursor without changing the computed width,
 * leaving stale glyphs, broken borders, and content bleeding across rows.
 * Normalize line breaks and remove everything that isn't printable text, \n, or
 * \t before the string ever reaches a Text/Markdown block. The app's own
 * coloring is applied AFTER this, so legitimate styling is unaffected.
 */
export function sanitizeForDisplay(s: string): string {
  return s
    .replace(/\r\n?/g, "\n") // CRLF / lone CR → LF (HTTP, curl progress)
    .replace(/\x1b\][\s\S]*?(?:\x07|\x1b\\)/g, "") // OSC ... BEL/ST
    .replace(/\x1b[P^_][\s\S]*?\x1b\\/g, "") // DCS / PM / APC ... ST
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "") // CSI (colors, cursor moves)
    .replace(/\x1b[@-Z\\-_O]/g, "") // 2-char escapes (Fe) + SS3 intro
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, ""); // leftover C0 + DEL (keep \t,\n)
}

/** Full-width horizontal rule that adapts to viewport width. */
export class DynamicBorder implements Component {
  constructor(private color: (s: string) => string = t.border) {}
  invalidate(): void {}
  render(width: number): string[] {
    return [this.color("─".repeat(Math.max(1, width)))];
  }
}

/** User message: padded background box with a label + markdown body. */
export class UserMessage extends Container {
  constructor(text: string) {
    super();
    const box = new Box(1, 0, t.userBg);
    box.addChild(new Text(t.bold(t.accent("you")), 0, 0));
    box.addChild(new Markdown(text, 0, 0, markdownTheme));
    this.addChild(box);
  }
}

/** Streaming reasoning trace: dim, italic, with a header. Collapses to a label when done. */
export class ReasoningBlock implements Component {
  private buf = "";
  private done = false;
  private expanded = false;
  invalidate(): void {}
  private static TAIL = 3; // visible reasoning lines while streaming

  /** Ctrl+E: show the full trace (even after it collapses to a label). */
  setExpanded(v: boolean) {
    this.expanded = v;
  }

  render(width: number): string[] {
    if (this.buf.trim().length === 0) return [];
    const header = t.dim(t.italic("✳ thinking")) + (this.expanded ? "" : t.dim("  (Ctrl+E)"));
    if (this.done && !this.expanded) return [" " + header];

    // wrap the whole trace; show full when expanded, else a rolling tail
    const wrapped: string[] = [];
    for (const raw of this.buf.split("\n")) {
      let line = raw.replace(/\s+$/g, "");
      if (line.length === 0) continue;
      while (line.length > 0) {
        const slice = line.slice(0, Math.max(1, width - 2));
        wrapped.push(slice);
        line = line.slice(slice.length);
      }
    }
    const visible = this.expanded ? wrapped : wrapped.slice(-ReasoningBlock.TAIL);
    return [" " + header, ...visible.map((l) => " " + t.dim(t.italic(l)))];
  }
  append(delta: string) {
    this.buf += sanitizeForDisplay(delta);
  }
  finish() {
    this.done = true;
  }
}

export type ToolState = "queued" | "running" | "success" | "error";

/** Braille spinner frames — same set pi-tui's Loader uses for the thinking line. */
export const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

const MAX_TOOL_ARG_CHARS = 1000;

/** One-line preview of a tool call's input, capped to 1000 chars for display. */
export function toolArgPreview(name: string, input: any): string {
  let raw: string;
  if (name === "bash") {
    raw = String(input?.command ?? "");
  } else {
    try {
      raw = JSON.stringify(input) ?? String(input);
    } catch {
      raw = String(input);
    }
  }
  return raw.length > MAX_TOOL_ARG_CHARS
    ? raw.slice(0, MAX_TOOL_ARG_CHARS) + ` … (+${raw.length - MAX_TOOL_ARG_CHARS} chars)`
    : raw;
}

/** Tool execution block: state-colored background box, title line + output. */
export class ToolBlock extends Container {
  private box: Box;
  private titleText: Text;
  private outputText: Text;
  private state: ToolState = "queued";
  private output = "";
  private expanded = false;
  private meta: ToolEventInfo | null = null;

  constructor(
    private name: string,
    private argPreview: string,
    // Animated frame source while running; falls back to a static glyph.
    private spinner?: () => string,
  ) {
    super();
    this.box = new Box(1, 0, t.toolPendingBg);
    this.titleText = new Text("", 0, 0);
    this.outputText = new Text("", 0, 0);
    this.box.addChild(this.titleText);
    this.addChild(this.box);
    this.refresh();
  }

  /** Re-render the title so the running spinner advances a frame. */
  tick() {
    if (this.state === "running") this.refresh();
  }

  private bgFor(): (s: string) => string {
    return this.state === "error"
        ? t.toolErrorBg
        : this.state === "success"
          ? t.toolSuccessBg
          : t.toolPendingBg;
  }

  private icon(): string {
    return this.state === "queued"
      ? "□"
      : this.state === "running"
        ? (this.spinner ? this.spinner() : "▷")
        : this.state === "error"
          ? "✗"
          : "✓";
  }

  private label(): string {
    if (!this.meta) return "";
    const pos = `${this.meta.index + 1}/${this.meta.total}`;
    const mode = this.meta.concurrencySafe ? "parallel" : "serial";
    const wait =
      this.meta.queueMs !== undefined && this.meta.queueMs > 20
        ? ` wait ${formatMs(this.meta.queueMs)}`
        : "";
    const took =
      this.meta.durationMs !== undefined
        ? ` took ${formatMs(this.meta.durationMs)}`
        : "";
    return `  ${pos} ${mode}${wait}${took}`;
  }

  private refresh() {
    this.box.setBgFn(this.bgFor());
    const title =
      t.toolTitle(t.bold(`${this.icon()} ${this.name}`)) +
      t.dim(this.label()) +
      (this.argPreview ? t.toolOutput(`  ${this.argPreview}`) : "");
    this.titleText.setText(title);

    this.box.removeChild(this.outputText);
    if (this.output.trim().length > 0) {
      const max = this.expanded ? Infinity : 12;
      const all = this.output.replace(/\s+$/g, "").split("\n");
      const shown = all.slice(0, max);
      let body = shown.map((l) => t.toolOutput(l)).join("\n");
      if (all.length > shown.length) {
        body += "\n" + t.dim(`… +${all.length - shown.length} lines (Ctrl+O)`);
      }
      this.outputText.setText(body);
      this.box.addChild(this.outputText);
    }
  }

  /** Ctrl+O: show the full output instead of the 12-line cap. */
  setExpanded(v: boolean) {
    this.expanded = v;
    this.refresh();
  }

  setMeta(info: ToolEventInfo) {
    this.meta = info;
    this.refresh();
  }

  start() {
    this.state = "running";
    this.refresh();
  }

  setResult(output: string, isError: boolean) {
    this.output = sanitizeForDisplay(output);
    this.state = isError ? "error" : "success";
    this.refresh();
  }
}

function formatMs(ms: number): string {
  if (ms < 1000) return `${Math.max(0, Math.round(ms))}ms`;
  return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`;
}

/** Plain dim status line used for system notices. */
export function notice(text: string): Component {
  return new Text(t.dim(text), 1, 0);
}

/** Harness-injected context block (e.g. background-task updates). */
export function noteBlock(content: string): Component {
  return new Text(
    t.dim(t.italic("⟳ context")) + "\n" + t.muted(sanitizeForDisplay(content)),
    1,
    0,
  );
}

export function clampLine(s: string, width: number): string {
  return truncateToWidth(s, width);
}

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
    this.buf += delta;
  }
  finish() {
    this.done = true;
  }
}

export type ToolState = "pending" | "success" | "error";

/** Tool execution block: state-colored background box, title line + output. */
export class ToolBlock extends Container {
  private box: Box;
  private titleText: Text;
  private outputText: Text;
  private state: ToolState = "pending";
  private output = "";
  private expanded = false;

  constructor(
    private name: string,
    private argPreview: string,
  ) {
    super();
    this.box = new Box(1, 0, t.toolPendingBg);
    this.titleText = new Text("", 0, 0);
    this.outputText = new Text("", 0, 0);
    this.box.addChild(this.titleText);
    this.addChild(this.box);
    this.refresh();
  }

  private bgFor(): (s: string) => string {
    return this.state === "pending"
      ? t.toolPendingBg
      : this.state === "error"
        ? t.toolErrorBg
        : t.toolSuccessBg;
  }

  private icon(): string {
    return this.state === "pending" ? "▷" : this.state === "error" ? "✗" : "✓";
  }

  private refresh() {
    this.box.setBgFn(this.bgFor());
    const title =
      t.toolTitle(t.bold(`${this.icon()} ${this.name}`)) +
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

  setResult(output: string, isError: boolean) {
    this.output = output;
    this.state = isError ? "error" : "success";
    this.refresh();
  }
}

/** Plain dim status line used for system notices. */
export function notice(text: string): Component {
  return new Text(t.dim(text), 1, 0);
}

/** Harness-injected context block (e.g. background-task updates). */
export function noteBlock(content: string): Component {
  return new Text(t.dim(t.italic("⟳ context")) + "\n" + t.muted(content), 1, 0);
}

export function clampLine(s: string, width: number): string {
  return truncateToWidth(s, width);
}

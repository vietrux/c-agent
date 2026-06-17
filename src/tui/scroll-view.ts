import { Container, type Component, type TUI } from "@earendil-works/pi-tui";
import { t } from "./themes.js";

/**
 * Wraps the transcript so it can be scrolled inside the alternate screen
 * buffer, which (unlike the normal buffer) has no native scrollback.
 *
 * When disabled — i.e. normal inline mode — it's a pass-through: the whole
 * transcript renders and the terminal's own scrollback handles history.
 *
 * When enabled (fullscreen) it renders only a window of the content, sized to
 * the rows left above the editor + footer, and `scroll` shifts that window up
 * from the bottom. A `scroll` of 0 pins to the latest line and auto-follows new
 * output, matching the inline behaviour users expect.
 */
export class ScrollView implements Component {
  /** Toggled on with fullscreen; off restores the inline pass-through. */
  enabled = false;

  private scroll = 0; // lines above the bottom; 0 = pinned to latest
  private windowLen = 0; // visible window height at last render
  private maxScroll = 0; // furthest scroll that still shows new content (from render)

  constructor(
    readonly inner: Container,
    private tui: TUI,
    /** Rows used below the transcript (editor + footer), measured per render. */
    private reservedBelow: (width: number) => number,
  ) {}

  invalidate() {
    this.inner.invalidate();
  }

  /** True while showing older content — input handlers grab keys like End then. */
  get scrolledUp(): boolean {
    return this.enabled && this.scroll > 0;
  }

  /** Snap back to the latest line (resume auto-follow). */
  toBottom(): void {
    if (this.scroll !== 0) {
      this.scroll = 0;
      this.tui.requestRender();
    }
  }

  /** Scroll by `delta` lines (positive = toward older content). */
  scrollByLines(delta: number): void {
    if (!this.enabled) return;
    const next = Math.max(0, Math.min(this.maxScroll, this.scroll + delta));
    if (next !== this.scroll) {
      this.scroll = next;
      this.tui.requestRender();
    }
  }

  /** Scroll one near-full page (positive = up/older). */
  scrollByPage(direction: number): void {
    this.scrollByLines(direction * Math.max(1, this.windowLen - 2));
  }

  render(width: number): string[] {
    const all = this.inner.render(width);
    if (!this.enabled) {
      this.scroll = 0;
      return all;
    }
    const vh = Math.max(1, this.tui.terminal.rows - this.reservedBelow(width));
    this.windowLen = vh;
    // Everything fits — nothing to scroll, just show it all.
    if (all.length <= vh) {
      this.scroll = 0;
      this.maxScroll = 0;
      return all;
    }
    // Reserve the bottom row of the window for the scroll indicator when scrolled.
    const bodyH = Math.max(1, vh - 1);
    this.maxScroll = all.length - bodyH;
    if (this.scroll > this.maxScroll) this.scroll = this.maxScroll;
    if (this.scroll <= 0) {
      this.scroll = 0;
      return all.slice(all.length - vh); // pinned to latest, full height
    }
    const end = all.length - this.scroll;
    const start = Math.max(0, end - bodyH);
    const win = all.slice(start, end);
    const hidden = this.scroll;
    win.push(
      t.dim(
        `  ↓ ${hidden} more line${hidden === 1 ? "" : "s"} below · PgUp/PgDn scroll · End → latest`,
      ),
    );
    return win;
  }
}

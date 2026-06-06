import {
  Container,
  Spacer,
  Text,
  truncateToWidth,
  matchesKey,
  Key,
  type Component,
} from "@earendil-works/pi-tui";
import { t } from "./themes.js";
import { DynamicBorder } from "./components.js";

export interface RewindItem {
  index: number;
  label: string;
  subtitle?: string; // secondary line; defaults to "message N of M"
  header?: boolean; // non-selectable group title (skipped during navigation)
}

/** Keyboard-driven list with cursor + scroll window. Renders ≤ width per line. */
class List implements Component {
  private sel: number;
  onSelect?: (index: number) => void;
  onCancel?: () => void;
  onDelete?: (index: number) => void;
  constructor(
    private items: RewindItem[],
    private maxVisible = 8,
    startAt: "first" | "last" = "last",
  ) {
    this.sel = startAt === "first" ? this.firstSelectable() : this.lastSelectable();
  }

  invalidate(): void {}

  private selectable(i: number): boolean {
    return !!this.items[i] && !this.items[i].header;
  }
  private firstSelectable(): number {
    for (let i = 0; i < this.items.length; i++) if (this.selectable(i)) return i;
    return 0;
  }
  private lastSelectable(): number {
    for (let i = this.items.length - 1; i >= 0; i--) if (this.selectable(i)) return i;
    return 0;
  }
  /** Move from `from` in `dir` (±1), skipping headers, wrapping around. */
  private step(from: number, dir: number): number {
    const n = this.items.length;
    for (let k = 1; k <= n; k++) {
      const i = (((from + dir * k) % n) + n) % n;
      if (this.selectable(i)) return i;
    }
    return from;
  }

  render(width: number): string[] {
    if (this.items.length === 0) return [t.muted("  empty")];
    const half = Math.floor(this.maxVisible / 2);
    const start = Math.max(0, Math.min(this.sel - half, this.items.length - this.maxVisible));
    const end = Math.min(start + this.maxVisible, this.items.length);
    const lines: string[] = [];
    for (let i = start; i < end; i++) {
      const it = this.items[i];
      if (it.header) {
        lines.push(t.dim("── ") + t.bold(t.muted(truncateToWidth(it.label, width - 6))));
        continue;
      }
      const active = i === this.sel;
      const cursor = active ? t.accent("› ") : "  ";
      const label = truncateToWidth(it.label, width - 4);
      lines.push(cursor + (active ? t.bold(t.accent(label)) : t.text(label)));
      if (it.subtitle) lines.push("  " + t.muted(it.subtitle));
      lines.push("");
    }
    return lines;
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.up)) {
      this.sel = this.step(this.sel, -1);
    } else if (matchesKey(data, Key.down)) {
      this.sel = this.step(this.sel, +1);
    } else if (matchesKey(data, Key.enter)) {
      if (this.selectable(this.sel)) this.onSelect?.(this.items[this.sel].index);
    } else if (this.onDelete && (data === "d" || data === "D")) {
      if (this.selectable(this.sel)) this.onDelete(this.items[this.sel].index);
    } else if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
      this.onCancel?.();
    }
  }
}

/**
 * Full-width rewind selector mounted in place of the editor (not an overlay).
 * Header + border + list + border, matching the chat layout flow.
 */
export class RewindSelector extends Container {
  private list: List;
  constructor(items: RewindItem[], onSelect: (index: number) => void, onCancel: () => void) {
    super();
    this.addChild(new Spacer(1));
    this.addChild(new Text(t.bold("Rewind conversation"), 1, 0));
    this.addChild(
      new Text(t.muted("Pick a message to roll back to. ↑/↓ select · Enter confirm · Esc cancel"), 1, 0),
    );
    this.addChild(new Spacer(1));
    this.addChild(new DynamicBorder());
    this.addChild(new Spacer(1));
    this.list = new List(items);
    this.list.onSelect = onSelect;
    this.list.onCancel = onCancel;
    this.addChild(this.list);
    this.addChild(new Spacer(1));
    this.addChild(new DynamicBorder());
  }

  /** TUI focuses this container; forward keys to the inner list. */
  handleInput(data: string): void {
    this.list.handleInput(data);
  }
}

/**
 * Searchable model picker. Each item label is `model (Provider)`. Type to filter
 * (handles 100s–1000s of models); ↑/↓ move, Enter confirms, Esc cancels. The
 * selected item's `index` is passed to onSelect.
 */
export class ModelSelector extends Container {
  private query = "";
  private list!: List;
  private listHost = new Container();
  private searchText = new Text("", 1, 0);

  constructor(
    private all: RewindItem[],
    private onSelect: (index: number) => void,
    private onCancel: () => void,
  ) {
    super();
    this.addChild(new Spacer(1));
    this.addChild(new Text(t.bold("Select model") + t.muted("  ·  type to search"), 1, 0));
    this.addChild(this.searchText);
    this.addChild(new Spacer(1));
    this.addChild(new DynamicBorder());
    this.addChild(new Spacer(1));
    this.addChild(this.listHost);
    this.addChild(new Spacer(1));
    this.addChild(new DynamicBorder());
    this.rebuild();
  }

  private rebuild() {
    const q = this.query.toLowerCase();
    const filtered = q ? this.all.filter((it) => it.label.toLowerCase().includes(q)) : this.all;
    this.searchText.setText(
      t.muted("search: ") +
        t.accent(this.query || "") +
        t.dim("▌") +
        t.muted(`   (${filtered.length}/${this.all.length})`),
    );
    this.listHost.clear();
    this.list = new List(filtered, 10);
    this.list.onSelect = this.onSelect;
    this.list.onCancel = this.onCancel;
    this.listHost.addChild(this.list);
  }

  handleInput(data: string): void {
    if (
      matchesKey(data, Key.up) ||
      matchesKey(data, Key.down) ||
      matchesKey(data, Key.enter) ||
      matchesKey(data, Key.escape) ||
      matchesKey(data, Key.ctrl("c"))
    ) {
      this.list.handleInput(data);
      return;
    }
    if (data === "\x7f" || data === "\b") {
      if (this.query) {
        this.query = this.query.slice(0, -1);
        this.rebuild();
      }
      return;
    }
    if (/^[\x20-\x7e]$/.test(data)) {
      this.query += data;
      this.rebuild();
    }
  }
}

/** Full-width list picker with a custom title/hint (sessions, bg tasks, …). */
export class ListSelector extends Container {
  private list: List;
  constructor(
    title: string,
    hint: string,
    items: RewindItem[],
    onSelect: (index: number) => void,
    onCancel: () => void,
    startAt: "first" | "last" = "last",
    onDelete?: (index: number) => void,
  ) {
    super();
    this.addChild(new Spacer(1));
    this.addChild(new Text(t.bold(title), 1, 0));
    this.addChild(new Text(t.muted(hint), 1, 0));
    this.addChild(new Spacer(1));
    this.addChild(new DynamicBorder());
    this.addChild(new Spacer(1));
    this.list = new List(items, 8, startAt);
    this.list.onSelect = onSelect;
    this.list.onCancel = onCancel;
    this.list.onDelete = onDelete;
    this.addChild(this.list);
    this.addChild(new Spacer(1));
    this.addChild(new DynamicBorder());
  }

  handleInput(data: string): void {
    this.list.handleInput(data);
  }
}

/** Full-width session picker (same layout flow as the rewind selector). */
export class SessionSelector extends ListSelector {
  constructor(
    items: RewindItem[],
    onSelect: (index: number) => void,
    onCancel: () => void,
    onDelete?: (index: number) => void,
  ) {
    super(
      "Resume session",
      "Pick a session to load. ↑/↓ select · Enter confirm · d delete · Esc cancel",
      items,
      onSelect,
      onCancel,
      "first", // sessions are newest-first → land the cursor on the latest
      onDelete,
    );
  }
}

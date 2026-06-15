import { homedir } from "node:os";
import { relative, resolve, sep } from "node:path";
import { truncateToWidth, visibleWidth, type Component } from "@earendil-works/pi-tui";
import { t } from "./themes.js";

export interface FooterData {
  status(): string; // "ready" | "thinking…" | "tool: bash"
  model(): string;
  provider(): string;
  mode(): string; // permission mode
  undercover(): boolean; // PII masking active
  turns(): number;
  cwd(): string;
  usage(): { input: number; output: number; cached: number };
  context(): { used: number; limit: number }; // context-window occupancy
  effort(): string | null; // active reasoning effort, if overridden
}

function fmtTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

function shortCwd(cwd: string): string {
  const home = homedir();
  const rel = relative(home, resolve(cwd));
  if (rel === "") return "~";
  if (!rel.startsWith("..") && !rel.startsWith(sep)) return "~" + sep + rel;
  return cwd;
}

/** Two-line status footer: pwd line + status/model line (model right-aligned). */
export class Footer implements Component {
  constructor(private data: FooterData) {}
  invalidate(): void {}

  render(width: number): string[] {
    const pwd = truncateToWidth(t.dim(shortCwd(this.data.cwd())), width, t.dim("…"));

    const statusRaw = this.data.status();
    const u = this.data.usage();
    const tok =
      u.input || u.output
        ? t.dim(`  ·  ↑${fmtTokens(u.input)} ↓${fmtTokens(u.output)}`) +
          (u.cached ? t.dim(` (cache ${fmtTokens(u.cached)})`) : "")
        : "";
    const { used, limit } = this.data.context();
    const pct = limit > 0 ? Math.min(999, Math.round((used / limit) * 100)) : 0;
    // Green under 60%, amber 60–80%, red above — mirrors the compaction threshold.
    const ctxColor = pct >= 80 ? t.error : pct >= 60 ? t.warning : t.muted;
    const ctxTag = t.dim("  ·  ") + ctxColor(`${pct}% ctx`);
    const effortVal = this.data.effort();
    const effortTag = effortVal ? t.dim("  ·  ") + t.muted("effort: ") + t.accent(effortVal) : "";
    const mode = this.data.mode();
    const modeColor = mode === "default" ? t.muted : t.warning;
    const modeTag = t.dim("  ·  ") + t.muted("mode: ") + modeColor(mode);
    const undercoverTag = this.data.undercover() ? t.dim("  ·  ") + t.warning("🕶 undercover") : "";
    const left =
      (statusRaw === "ready" ? t.success("●") : t.warning("●")) +
      " " +
      t.muted(statusRaw) +
      t.dim(`  ·  ${this.data.turns()} turns`) +
      tok +
      ctxTag +
      effortTag +
      modeTag +
      undercoverTag;
    const right = t.dim(`${this.data.provider()} `) + t.accent(this.data.model());

    const lw = visibleWidth(left);
    const rw = visibleWidth(right);
    let line: string;
    if (lw + 2 + rw <= width) {
      line = left + " ".repeat(width - lw - rw) + right;
    } else {
      line = truncateToWidth(left, width);
    }
    return [pwd, line];
  }
}

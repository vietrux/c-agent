import { Chalk } from "chalk";
import type { EditorTheme, MarkdownTheme, SelectListTheme } from "@earendil-works/pi-tui";

// Force at least 256-color; chalk.hex auto-downsamples to the terminal's real depth.
const k = new Chalk({ level: 3 });

// Monochrome palette — black / white / grey only. chalk.hex degrades gracefully.
const C = {
  text: "#d4d4d4",
  accent: "#ffffff",
  muted: "#9a9a9a",
  dim: "#6a6a6a",
  border: "#404040",
  borderAccent: "#ffffff",
  success: "#e0e0e0",
  error: "#ffffff",
  warning: "#bdbdbd",
  thinking: "#7a7a7a",
  userBg: "#1c1c1c",
  userText: "#ffffff",
  toolTitle: "#ffffff",
  toolOutput: "#a8a8a8",
  toolPendingBg: "#1a1a1a",
  toolSuccessBg: "#202020",
  toolErrorBg: "#2b2b2b",
  selectedBg: "#333333",
  mdHeading: "#ffffff",
  mdCode: "#e0e0e0",
  mdCodeBlock: "#bdbdbd",
  mdQuote: "#9a9a9a",
  mdLink: "#e0e0e0",
  mdBullet: "#cccccc",
} as const;

/** Foreground + style helpers. */
export const t = {
  text: (s: string) => k.hex(C.text)(s),
  accent: (s: string) => k.hex(C.accent)(s),
  muted: (s: string) => k.hex(C.muted)(s),
  dim: (s: string) => k.hex(C.dim)(s),
  border: (s: string) => k.hex(C.border)(s),
  borderAccent: (s: string) => k.hex(C.borderAccent)(s),
  success: (s: string) => k.hex(C.success)(s),
  error: (s: string) => k.hex(C.error)(s),
  warning: (s: string) => k.hex(C.warning)(s),
  thinking: (s: string) => k.hex(C.thinking)(s),
  toolTitle: (s: string) => k.hex(C.toolTitle)(s),
  toolOutput: (s: string) => k.hex(C.toolOutput)(s),
  bold: (s: string) => k.bold(s),
  italic: (s: string) => k.italic(s),
  // background fill helpers (for Box / Text bgFn)
  userBg: (s: string) => k.bgHex(C.userBg).hex(C.userText)(s),
  toolPendingBg: (s: string) => k.bgHex(C.toolPendingBg)(s),
  toolSuccessBg: (s: string) => k.bgHex(C.toolSuccessBg)(s),
  toolErrorBg: (s: string) => k.bgHex(C.toolErrorBg)(s),
  selectedBg: (s: string) => k.bgHex(C.selectedBg)(s),
};

export const markdownTheme: MarkdownTheme = {
  heading: (s) => k.bold.hex(C.mdHeading)(s),
  link: (s) => k.hex(C.mdLink)(s),
  linkUrl: (s) => k.hex(C.dim)(s),
  code: (s) => k.hex(C.mdCode)(s),
  codeBlock: (s) => k.hex(C.mdCodeBlock)(s),
  codeBlockBorder: (s) => k.hex(C.border)(s),
  quote: (s) => k.italic.hex(C.mdQuote)(s),
  quoteBorder: (s) => k.hex(C.border)(s),
  hr: (s) => k.hex(C.border)(s),
  listBullet: (s) => k.hex(C.mdBullet)(s),
  bold: (s) => k.bold(s),
  italic: (s) => k.italic(s),
  strikethrough: (s) => k.strikethrough(s),
  underline: (s) => k.underline(s),
};

export const selectListTheme: SelectListTheme = {
  selectedPrefix: (s) => t.accent(s),
  selectedText: (s) => t.accent(s),
  description: (s) => t.muted(s),
  scrollInfo: (s) => t.muted(s),
  noMatch: (s) => t.muted(s),
};

export const editorTheme: EditorTheme = {
  borderColor: (s) => t.border(s),
  selectList: selectListTheme,
};

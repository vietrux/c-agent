import {
  Container,
  Input,
  SelectList,
  Spacer,
  Text,
  truncateToWidth,
} from "@earendil-works/pi-tui";
import { t, selectListTheme } from "./themes.js";
import { DynamicBorder } from "./components.js";
import type { ConfirmRequest, ConfirmResult } from "../tools/registry.js";

type Phase = "choose" | "reason";

/**
 * Full-width approval prompt mounted in place of the editor.
 *
 * Phase 1 — choice list:
 *   Allow once  /  Always allow <label>  /  Deny
 *
 * Phase 2 — triggered on Deny:
 *   Single-line reason input. Enter submits (empty = no feedback). Esc skips.
 *
 * The "Always allow" option label is derived from the suggestion in the
 * request: for bash it shows the per-command prefix ("git commit …"), for
 * other tools it shows the tool name.
 */
export class PermissionPrompt extends Container {
  private phase: Phase = "choose";
  private list: SelectList;
  private reasonInput: Input | null = null;
  private reasonHost = new Container();

  constructor(req: ConfirmRequest, onDecide: (r: ConfirmResult) => void) {
    super();

    const { name, preview, suggestion } = req;
    const alwaysLabel = suggestion
      ? `Always allow "${suggestion.label}"`
      : `Always allow ${name}`;

    this.addChild(new Spacer(1));
    this.addChild(new Text(t.bold(t.warning("⚠ permission required")), 1, 0));
    this.addChild(new Text(t.muted("tool ") + t.accent(name), 1, 0));
    if (preview) this.addChild(new Text(t.dim(truncateLine(preview)), 1, 0));
    this.addChild(new Spacer(1));
    this.addChild(new DynamicBorder());

    this.list = new SelectList(
      [
        { value: "allow",  label: "Allow once",   description: "Run this call" },
        { value: "always", label: alwaysLabel,     description: "Don't ask again this session" },
        { value: "deny",   label: "Deny",          description: "Reject — Tab to add reason" },
      ],
      3,
      selectListTheme,
    );

    this.list.onSelect = (item) => {
      if (item.value === "deny") {
        this.showReasonInput(onDecide);
      } else {
        onDecide({ decision: item.value as "allow" | "always" });
      }
    };
    this.list.onCancel = () => onDecide({ decision: "deny" });

    this.addChild(this.list);
    this.addChild(this.reasonHost);
    this.addChild(new DynamicBorder());
  }

  private showReasonInput(onDecide: (r: ConfirmResult) => void) {
    this.phase = "reason";

    const label = new Text(
      t.bold(t.warning("Deny reason")) +
        t.muted("  (optional — Enter to submit, Esc to skip)"),
      1,
      0,
    );
    const input = new Input();
    input.focused = true;

    input.onSubmit = (value) => {
      onDecide({ decision: "deny", feedback: value.trim() || undefined });
    };
    input.onEscape = () => {
      onDecide({ decision: "deny" });
    };

    this.reasonInput = input;
    this.reasonHost.clear();
    this.reasonHost.addChild(new Spacer(1));
    this.reasonHost.addChild(label);
    this.reasonHost.addChild(input);
  }

  handleInput(data: string): void {
    if (this.phase === "reason" && this.reasonInput) {
      this.reasonInput.handleInput(data);
    } else {
      this.list.handleInput(data);
    }
  }
}

function truncateLine(s: string): string {
  const oneLine = s.replace(/\s+/g, " ").trim();
  return truncateToWidth(oneLine, 100);
}

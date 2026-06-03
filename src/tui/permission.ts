import { Container, SelectList, Spacer, Text, truncateToWidth } from "@earendil-works/pi-tui";
import { t, selectListTheme } from "./themes.js";
import { DynamicBorder } from "./components.js";
import type { Decision } from "../tools/registry.js";

/**
 * Full-width approval prompt mounted in place of the editor.
 * Allow once / Always allow this tool / Deny.
 */
export class PermissionPrompt extends Container {
  private list: SelectList;

  constructor(name: string, preview: string, onDecide: (d: Decision) => void) {
    super();
    this.addChild(new Spacer(1));
    this.addChild(new Text(t.bold(t.warning("⚠ permission required")), 1, 0));
    this.addChild(new Text(t.muted("tool ") + t.accent(name), 1, 0));
    if (preview) this.addChild(new Text(t.dim(truncateLine(preview)), 1, 0));
    this.addChild(new Spacer(1));
    this.addChild(new DynamicBorder());

    this.list = new SelectList(
      [
        { value: "allow", label: "Allow once", description: "Run this call" },
        { value: "always", label: `Always allow ${name}`, description: "Don't ask again this session" },
        { value: "deny", label: "Deny", description: "Reject this call" },
      ],
      3,
      selectListTheme,
    );
    this.list.onSelect = (item) => onDecide(item.value as Decision);
    this.list.onCancel = () => onDecide("deny");
    this.addChild(this.list);
    this.addChild(new DynamicBorder());
  }

  handleInput(data: string): void {
    this.list.handleInput(data);
  }
}

function truncateLine(s: string): string {
  const oneLine = s.replace(/\s+/g, " ").trim();
  return truncateToWidth(oneLine, 100);
}

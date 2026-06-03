import {
  TUI,
  Editor,
  Container,
  type Component,
} from "@earendil-works/pi-tui";
import { editorTheme } from "./themes.js";

/**
 * Owns the bottom region of the screen: the editor, plus any transient
 * selector/prompt that temporarily replaces it (model picker, rewind list,
 * permission prompt…). `exclusive` serializes prompts so parallel tool calls
 * can't fight over the single slot.
 */
export class BottomSlot {
  readonly container = new Container();
  readonly editor: Editor;
  private atEditor = true;
  private lock: Promise<unknown> = Promise.resolve();

  constructor(private tui: TUI) {
    this.editor = new Editor(tui, editorTheme);
    this.container.addChild(this.editor);
  }

  /** True when the editor (not a selector/prompt) holds the slot. */
  get isAtEditor() {
    return this.atEditor;
  }

  /** Replace the editor with a transient component and focus it. */
  swap(comp: Component) {
    this.atEditor = false;
    this.container.clear();
    this.container.addChild(comp);
    this.tui.setFocus(comp);
    this.tui.requestRender();
  }

  /** Restore the editor into the slot and focus it. */
  restore() {
    this.atEditor = true;
    this.container.clear();
    this.container.addChild(this.editor);
    this.tui.setFocus(this.editor);
    this.tui.requestRender();
  }

  focusEditor() {
    this.tui.setFocus(this.editor);
  }

  /** Run a bottom-slot prompt exclusively — one prompt at a time. */
  exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.lock.then(fn, fn);
    this.lock = result.then(
      () => {},
      () => {},
    );
    return result;
  }
}

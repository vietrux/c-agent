import {
  Container,
  Input,
  Spacer,
  Text,
  type Focusable,
} from "@earendil-works/pi-tui";
import { t } from "./themes.js";

/** In-flow question prompt: a label + single-line input, mounted where the editor sits. */
export class AskPrompt extends Container implements Focusable {
  private input = new Input();
  private _focused = false;
  get focused() {
    return this._focused;
  }
  set focused(v: boolean) {
    this._focused = v;
    this.input.focused = v;
  }
  constructor(question: string, onAnswer: (a: string) => void) {
    super();
    this.addChild(new Spacer(1));
    this.addChild(new Text(t.bold(t.warning("? ")) + t.text(question), 1, 0));
    this.input.onSubmit = (v) => onAnswer(v);
    this.addChild(this.input);
  }
  handleInput(data: string): void {
    this.input.handleInput(data);
  }
}

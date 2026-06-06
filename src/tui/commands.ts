import type { TUI } from "@earendil-works/pi-tui";
import { notice } from "./components.js";
import type { TranscriptView } from "./transcript.js";
import type { Session } from "../session.js";
import type { Agent } from "../agent.js";

/** The slice of App slash-commands dispatch to. */
export interface CommandHost {
  view: TranscriptView;
  session: Session;
  agent: Agent;
  tui: TUI;
  mcpSummary: string;
  newConversation(): void;
  openRewind(): void;
  openResume(): void;
  runCompact(): void;
  setUndercover(arg: string): void;
  pickModel(): void;
  openBgTasks(): void;
}

/** Route a `/command` line to the matching host action. */
export function handleCommand(host: CommandHost, line: string): void {
  const [cmd, ...rest] = line.split(/\s+/);
  const arg = rest.join(" ").trim();
  switch (cmd) {
    case "/exit":
    case "/quit":
      host.tui.stop();
      process.exit(0);
      break;
    case "/new":
      host.newConversation();
      break;
    case "/rewind":
      host.openRewind();
      break;
    case "/resume":
      host.openResume();
      break;
    case "/compact":
      host.runCompact();
      break;
    case "/undercover":
      host.setUndercover(arg);
      break;
    case "/model":
      host.pickModel();
      break;
    case "/bg":
      host.openBgTasks();
      break;
    case "/mcp":
      host.view.addBlock(notice(host.mcpSummary));
      break;
    case "/context":
      host.view.addBlock(
        notice(
          `~${host.agent.contextTokens().toLocaleString()} tokens · ${host.session.messages.length} messages`,
        ),
      );
      break;
    case "/help":
      host.view.addBlock(
        notice(
          "/resume  /rewind  /compact  /model  /undercover [on|off]  /bg  /mcp  /context  /new  /exit  ·  Tab: mode · Ctrl+B: background · Ctrl+O/E: expand",
        ),
      );
      break;
    default:
      host.view.addBlock(notice(`unknown command: ${cmd}`));
  }
}

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
  toggleFullscreen(arg?: string): void;
  leaveAltScreen(): void;
}

/** Route a `/command` line to the matching host action. */
export function handleCommand(host: CommandHost, line: string): void {
  const [cmd, ...rest] = line.split(/\s+/);
  const arg = rest.join(" ").trim();
  switch (cmd) {
    case "/exit":
    case "/quit":
      host.leaveAltScreen();
      host.tui.stop();
      process.exit(0);
      break;
    case "/fullscreen":
      host.toggleFullscreen(arg);
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
    case "/effort":
      host.view.addBlock(notice(host.agent.setEffort(arg)));
      host.tui.requestRender();
      break;
    case "/bg":
      host.openBgTasks();
      break;
    case "/mcp":
      host.view.addBlock(notice(host.mcpSummary));
      break;
    case "/context": {
      const used = host.agent.contextTokens();
      const limit = host.agent.contextLimit();
      const pct = limit > 0 ? Math.round((used / limit) * 100) : 0;
      host.view.addBlock(
        notice(
          `~${used.toLocaleString()} / ${limit.toLocaleString()} tokens (${pct}%) · ${host.session.messages.length} messages`,
        ),
      );
      break;
    }
    case "/help":
      host.view.addBlock(
        notice(
          "/resume  /rewind  /compact  /model  /effort <level>  /undercover [on|off]  /fullscreen [on|off]  /bg  /mcp  /context  /new  /exit  ·  Tab: mode · Ctrl+B: background · Ctrl+O/E: expand",
        ),
      );
      break;
    default:
      host.view.addBlock(notice(`unknown command: ${cmd}`));
  }
}

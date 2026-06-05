import { ModelSelector, type RewindItem } from "./selector.js";
import { AskPrompt } from "./prompts.js";
import { notice } from "./components.js";
import type { TranscriptView } from "./transcript.js";
import type { BottomSlot } from "./bottom-slot.js";
import type { TUI } from "@earendil-works/pi-tui";
import type { Agent } from "../agent.js";
import type { Provider } from "../provider/types.js";
import { savePrefs } from "../prefs.js";

export interface ProviderEntry {
  name: string;
  provider: Provider;
}

/** The slice of App the model picker drives. */
export interface ModelHost {
  busy: boolean;
  view: TranscriptView;
  slot: BottomSlot;
  agent: Agent;
  tui: TUI;
  providers: ProviderEntry[];
  activeProviderName: string;
  refreshHeader(): void;
}

const PROVIDER_LABELS: Record<string, string> = {
  anthropic: "Anthropic",
  openai: "OpenAI",
  nim: "NIM",
  openrouter: "OpenRouter",
};

function prettyProvider(name: string): string {
  return (
    PROVIDER_LABELS[name.toLowerCase()] ??
    (name.length <= 4 ? name.toUpperCase() : name[0].toUpperCase() + name.slice(1))
  );
}

/** Fetches models from every configured provider and runs the /model picker. */
export class ModelPicker {
  constructor(private host: ModelHost) {}

  /** Fetch models from every configured provider and let the user pick. */
  async pick(): Promise<void> {
    const host = this.host;
    if (host.busy) {
      host.view.addBlock(notice("can't switch model while the agent is working"));
      return;
    }
    const entries = host.providers;
    host.view.setLoader("listing models…");
    const lists = await Promise.all(
      entries.map((e) =>
        (e.provider.listModels ? e.provider.listModels() : Promise.resolve([])).then(
          (models) => models,
          () => [] as string[],
        ),
      ),
    );
    host.view.setLoader(null);

    // Flat, searchable list; each row labelled `model (Provider)`. A provider
    // whose list endpoint is empty/unavailable still appears: it falls back to
    // its configured model, or a "type a model id" row so it stays selectable.
    const items: RewindItem[] = [];
    const choices: { entry: ProviderEntry; model: string | null }[] = [];
    entries.forEach((entry, gi) => {
      let models = lists[gi];
      if (models.length === 0 && entry.provider.model) models = [entry.provider.model];
      const pp = prettyProvider(entry.name);
      if (models.length === 0) {
        const ci = choices.length;
        choices.push({ entry, model: null }); // manual entry
        items.push({ index: ci, label: `⌨ enter a model id… (${pp})` });
        return;
      }
      for (const model of models) {
        const ci = choices.length;
        choices.push({ entry, model });
        items.push({ index: ci, label: `${model} (${pp})` });
      }
    });

    if (choices.length === 0) {
      host.view.addBlock(notice("no providers available — check ~/.c-agent/settings.json"));
      return;
    }

    const selector = new ModelSelector(
      items,
      (i) => {
        const { entry, model } = choices[i];
        host.slot.restore();
        if (model === null) this.promptModelId(entry);
        else this.applyModel(entry, model);
      },
      () => host.slot.restore(),
    );
    host.slot.swap(selector);
  }

  /** Switch to a provider+model, persist the choice, refresh UI. */
  private applyModel(entry: ProviderEntry, model: string): void {
    const host = this.host;
    host.agent.swapProvider(entry.provider);
    host.agent.setModel(model);
    host.activeProviderName = entry.name;
    savePrefs({ lastProvider: entry.name, lastModel: model });
    host.refreshHeader();
    host.tui.requestRender();
  }

  /** Ask for a model id when a provider exposes no model list. */
  private promptModelId(entry: ProviderEntry): void {
    const host = this.host;
    const prompt = new AskPrompt(`model id for ${prettyProvider(entry.name)}`, (answer) => {
      host.slot.restore();
      const id = answer.trim();
      if (id) this.applyModel(entry, id);
    });
    host.slot.swap(prompt);
  }
}

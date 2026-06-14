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
  configuredModels?: string[];
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

function uniqueModels(models: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const m of models) {
    const id = m.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

function configuredModels(entry: ProviderEntry): string[] {
  return uniqueModels([entry.provider.model, ...(entry.configuredModels ?? [])]);
}

export type ProviderListState = {
  entry: ProviderEntry;
  remoteModels: string[];
  status: "pending" | "done";
};

export type ModelChoice = { entry: ProviderEntry; model: string | null };

export function buildModelItems(states: ProviderListState[]): {
  items: RewindItem[];
  choices: ModelChoice[];
} {
  const choices: ModelChoice[] = [];
  const items: RewindItem[] = [];

  for (const state of states) {
    const { entry } = state;
    const pp = prettyProvider(entry.name);
    const models = uniqueModels([...configuredModels(entry), ...state.remoteModels]);
    if (models.length === 0) {
      if (state.status === "pending") continue;
      const ci = choices.length;
      choices.push({ entry, model: null }); // manual entry
      items.push({ index: ci, label: `⌨ enter a model id… (${pp})` });
      continue;
    }
    for (const model of models) {
      const ci = choices.length;
      choices.push({ entry, model });
      items.push({ index: ci, label: `${model} (${pp})` });
    }
  }

  return { items, choices };
}

/** Fetches models from every configured provider and runs the /model picker. */
export class ModelPicker {
  constructor(private host: ModelHost) {}

  /** Fetch models from every configured provider and let the user pick. */
  pick(): void {
    const host = this.host;
    if (host.busy) {
      host.view.addBlock(notice("can't switch model while the agent is working"));
      return;
    }
    const entries = host.providers;
    if (entries.length === 0) {
      host.view.addBlock(notice("no providers available — check ~/.c-agent/settings.json"));
      return;
    }

    host.view.setLoader("listing models…");

    // Flat, searchable list; each row labelled `model (Provider)`. A provider
    // whose list endpoint is empty/unavailable still appears: it falls back to
    // its configured model, or a "type a model id" row so it stays selectable.
    const states: ProviderListState[] = entries.map((entry) => ({
      entry,
      remoteModels: [],
      status: entry.provider.listModels ? "pending" : "done",
    }));
    let cancelled = false;
    let choices: ModelChoice[] = [];

    const buildItems = (): RewindItem[] => {
      const built = buildModelItems(states);
      choices = built.choices;
      return built.items;
    };

    const selector = new ModelSelector(
      buildItems(),
      (i) => {
        cancelled = true;
        host.view.setLoader(null);
        const { entry, model } = choices[i];
        host.slot.restore();
        if (model === null) this.promptModelId(entry);
        else this.applyModel(entry, model);
      },
      () => {
        cancelled = true;
        host.view.setLoader(null);
        host.slot.restore();
      },
    );
    host.slot.swap(selector);

    const tasks = states.map(async (state) => {
      if (!state.entry.provider.listModels) return;
      try {
        state.remoteModels = await state.entry.provider.listModels();
      } catch {
        state.remoteModels = [];
      } finally {
        state.status = "done";
        if (!cancelled) {
          selector.setItems(buildItems());
          host.tui.requestRender();
        }
      }
    });

    void Promise.all(tasks).finally(() => {
      if (!cancelled) host.view.setLoader(null);
    });
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

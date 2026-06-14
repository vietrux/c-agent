# c-agent — Build & Install

Terminal coding agent. Installs as the `cagent` command.

## Requirements

- Node.js >= 20 (developed on 22)
- npm
- A model provider API key (NVIDIA NIM, OpenAI-compatible, or Anthropic-compatible)

## Build

```bash
npm install      # install dependencies
npm run build    # compile TypeScript -> dist/
```

## Install (global `cagent`)

Symlink the built binary onto your PATH:

```bash
npm link
```

`cagent` now runs from any directory. The link points at `dist/`, so after a
code change just rebuild (`npm run build`) — no relink needed.

Verify:

```bash
which cagent     # -> .../bin/cagent
cagent           # starts the TUI (needs a provider configured, see below)
```

### Alternative: frozen install

```bash
npm i -g .       # snapshot copy (must reinstall after each change)
```

### Uninstall

```bash
npm rm -g c-agent
```

## Configure a provider

Providers come **only** from `~/.c-agent/settings.json` (no built-in default).
With no provider configured, `cagent` exits with an error.

Create `~/.c-agent/settings.json`:

```json
{
  "providers": {
    "nim": {
      "type": "openai",
      "baseURL": "https://integrate.api.nvidia.com/v1",
      "apiKey": "nvapi-...",
      "model": "minimaxai/minimax-m2.7",
      "params": {
        "temperature": 0.2,
        "top_p": 0.95
      },
      "models": [
        "minimaxai/minimax-m2.7",
        {
          "id": "nvidia/llama-3.3-nemotron-super-49b-v1",
          "params": {
            "temperature": 0.4,
            "reasoning_effort": "high",
            "presence_penalty": 0.1,
            "frequency_penalty": 0.1
          }
        }
      ],
      "modelParams": {
        "minimaxai/minimax-m2.7": {
          "reasoning": { "effort": "medium" }
        }
      }
    },
    "anthropic": {
      "type": "anthropic",
      "apiKeyEnv": "ANTHROPIC_API_KEY"
    }
  }
}
```

```bash
chmod 600 ~/.c-agent/settings.json   # contains secrets
```

Provider fields:

| field       | meaning                                                        |
| ----------- | -------------------------------------------------------------- |
| `type`      | `openai` (OpenAI-compatible: OpenAI, NIM, vLLM, local) or `anthropic` |
| `baseURL`   | API base URL (optional for hosted OpenAI/Anthropic)            |
| `apiKey`    | key inline; use `""` only for custom no-auth `baseURL` providers, **or** |
| `apiKeyEnv` | name of an env var holding the key (preferred)                 |
| `model`     | model id; omit to pick interactively in the TUI               |
| `models`    | extra static model ids to show in `/model`; entries can be strings or `{ "id", "params" }` objects |
| `params`    | provider-specific request params merged into every request      |
| `modelParams` | provider-specific request params keyed by model id            |

- `provider` (single object) = the active backend.
- `providers` (named map) = selectable backends; the first is active if no `provider` is set.
- Precedence for the active model: `--model` flag > last `/model` choice > config `model`.
- `/model` merges provider-listed models with `model` and `models`, so configured
  model ids remain selectable even if a provider list endpoint is slow, empty,
  or does not return that id.
- Request params are passed through to the provider payload. Use `params` for
  defaults and `modelParams` or inline `models[].params` for model-specific
  overrides such as `temperature`, `top_p`, `presence_penalty`,
  `frequency_penalty`, `reasoning`, `reasoning_effort`, Anthropic
  `thinking`, or Ollama `think`.
- Ollama's Anthropic-compatible endpoint can return thinking blocks directly;
  c-agent surfaces those in the TUI thinking panel. Ollama's OpenAI-compatible
  endpoint streams thinking as `delta.reasoning`, which c-agent also surfaces.

## Run

```bash
cagent                 # start in the current directory
cagent --continue      # resume the latest session for this directory
cagent --resume <id>   # resume a specific session
cagent --model <id>    # force a model for this run
```

## In the TUI

- Type to chat. `/help` lists commands.
- `Tab` cycle permission mode · `Ctrl+B` background the running command ·
  `Ctrl+O`/`Ctrl+E` expand tool output / thinking.
- `/model` pick a model (searchable, grouped by provider) — choice persists to next launch.
- `/resume` `/rewind` `/compact` `/bg` `/undercover` `/mcp` `/context` `/clear` `/exit`.

## Develop

```bash
npm run dev            # run from source via tsx (no build)
npm run build          # recompile; linked `cagent` picks it up
```

State lives under `~/.c-agent/`: `settings.json` (config), `state.json` (last
model), `sessions/` (transcripts).

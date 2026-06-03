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

## Standalone binaries (multiple OS)

Build self-contained executables (bundled runtime — no Node needed on the target)
for the common OS/arch targets. Requires [Bun](https://bun.sh) on the build machine;
Bun cross-compiles all targets from any one host.

```bash
npm run build:bin            # all targets → dist-bin/
npm run build:bin -- linux-x64 darwin-arm64   # only specific targets
```

Outputs in `dist-bin/`:

| file                       | OS / arch              |
| -------------------------- | ---------------------- |
| `cagent-linux-x64`         | Linux x86-64           |
| `cagent-linux-arm64`       | Linux ARM64            |
| `cagent-darwin-x64`        | macOS Intel            |
| `cagent-darwin-arm64`      | macOS Apple Silicon    |
| `cagent-windows-x64.exe`   | Windows x86-64         |

Run directly, e.g. `./dist-bin/cagent-linux-x64`. Each still needs
`~/.c-agent/settings.json` for a provider. Binaries are ~60–112 MB (embedded
runtime) and are gitignored.

Notes:
- Only the Linux x64 build is smoke-tested in CI/dev here; macOS and Windows
  binaries are produced but must be verified on their own OS.
- pi-tui's optional native key-modifier addons are not embedded; the binaries
  fall back gracefully (key handling still works via escape sequences).
- On Windows the agent's `bash` tool needs a POSIX shell (Git Bash / WSL);
  the rest of the TUI is cross-platform.

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
      "model": "minimaxai/minimax-m2.7"
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
| `apiKey`    | key inline, **or**                                             |
| `apiKeyEnv` | name of an env var holding the key (preferred)                 |
| `model`     | model id; omit to pick interactively in the TUI               |

- `provider` (single object) = the active backend.
- `providers` (named map) = selectable backends; the first is active if no `provider` is set.
- Precedence for the active model: `--model` flag > last `/model` choice > config `model`.

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

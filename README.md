# pi-agent-starter

Turnkey starter kit and curated distribution for the [Pi coding agent](https://github.com/badlogic/pi). It bundles modular agent skills, interactive extensions, standalone TypeScript extensions, subagent orchestration profiles, autohooks, themes, and engineering system prompt personas for immediate setup.

---

## Quickstart

```bash
# 1. Clone recursively into ~/.pi/agent (backup existing config if present)
[ -d ~/.pi/agent ] && mv ~/.pi/agent ~/.pi/agent.bak
git clone --recursive https://github.com/ArdaYILDIZ-DEV/pi-agent-starter.git ~/.pi/agent

# 2. Launch Pi and authenticate with your provider
pi
# Inside Pi:
/login
```

> **Note:** If cloned without `--recursive`, run `git submodule update --init --recursive` inside `~/.pi/agent`.

---

## What is Included

### Curated Skills (`skills/`)

Public skills maintained in [`pi-skills-public`](https://github.com/ArdaYILDIZ-DEV/pi-skills-public):

| Skill | Description | Invocable |
|---|---|---|
| `apple-inspired-web-design` | Apple HIG design tokens, color palette, and layout principles | Automatic |
| `avoid-ai-design` | UI design audit eliminating generic AI frontend patterns | Automatic |
| `browsing-reddit` | Token-efficient Reddit reader using `rdt-tidy` | Automatic |
| `casual-internet-english-writer` | Direct forum, Reddit, and social prose without corporate fluff | Manual |
| `comment-audit` | Standardized comment and docstring pruning across languages | Automatic |
| `conventional-commit` | Conventional Commits 1.0.0 message drafting and checks | Automatic |
| `crafting-tasteful-interfaces` | Production-grade frontend UI with deliberate typography and color tokens | Automatic |
| `how-to-use-subagents` | Delegation and steering rules for Pi subagents in tmux | Automatic |
| `no-ai-slop-frontend` | Frontend styling guidance avoiding common AI template tells | Automatic |
| `pi-extension-development` | ExtensionAPI guidelines, widgets, and lifecycle hooks | Automatic |
| `professional-english-writer` | Concise professional English for PRs, issues, and documentation | Manual |
| `research` | Multi-source web research with scoped queries and exact citations | Automatic |
| `tmux-orchestration` | Isolated background command execution in dedicated tmux sessions | Automatic |
| `verify` | Targeted verification with fail-first evidence and exit codes | Automatic |
| `writing-great-agents-md` | Rules authoring for repository `AGENTS.md` instruction files | Automatic |
| `writing-great-prompts` | Prompt engineering principles, constraints, and delimiters | Manual |
| `writing-great-readmes` | Evidence-based technical README authoring | Automatic |
| `writing-great-skills` | Agent skill authoring, progressive disclosure, and validation tooling | Automatic |
| `writing-great-system-prompts` | System prompt authority hierarchy and output contracts | Automatic |

### Extensions (`extensions/`)

- **Submodules**:
  - [`pi-interactive-subagents`](https://github.com/ArdaYILDIZ-DEV/pi-interactive-subagents): Tmux subagent orchestration with background steering and live status widgets.
  - [`pi-cc-ui`](https://github.com/ArdaYILDIZ-DEV/pi-cc-ui): Claude Code style progress spinner and prompt cache hit counter.
  - [`pi-prompt-snippets`](https://github.com/ArdaYILDIZ-DEV/pi-prompt-snippets): Composable prompt snippets with interactive selection.
  - [`pi-safe-bash-guard`](https://github.com/ArdaYILDIZ-DEV/pi-safe-bash-guard): Command safety engine preventing destructive mutations outside approved scopes.
- **Standalone TypeScript Extensions**:
  - `arda-kilo-models.ts`: Kilo Code OAuth provider integration enabling `/login` and dynamic model discovery.
  - `ask-user-question.ts`: Interactive single-question prompt dialog with options.
  - `goal.ts`: Token-budgeted goal lifecycle tracker.
  - `prompt-editor.ts`: Opens current prompt in external editor (`$EDITOR`).
  - `review.ts`: Interactive git diff review dialog before staging or committing.
  - `tools.ts`: Tool registration primitives.

### Subagent Personas (`agents/`)

- `scout.md`: Read-only reconnaissance specialist for locating files and mapping call graphs.
- `worker.md`: Implementation worker executing scoped edits, tests, and verification.
- `researcher.md`: Evidence-focused research specialist querying web sources and synthesizing briefs.

### Safety & Desktop Hooks (`autohooks/`)

- `pre-tool-use/10-read-before-edit.sh`: Enforces inspecting files with `read` before any edit or write mutation.
- `agent-stop/20-notify-on-stop.sh`: Desktop notification via `notify-send` when Pi finishes generating its response.

### System Prompts & Personas

- `SYSTEM.md` (`Elyndra`): Core persona emphasizing instruction hierarchy, live observation, zero fabrication, and concise communication.
- Specialized personas: Aster (strategy), Caelum (adversarial review), Kaida (entertainment), Liora (companion), and Neris (research).

### Themes & UI (`themes/`)

- `dark-cc.json`: Claude Code inspired high-contrast dark theme.
- `orange-dark.json`: Darkmatter warm orange dark theme.

---

## Configuration

### `settings.json`

Pre-configured with bundled packages, fullscreen TUI, compaction, and ASCII header:

```json
{
  "theme": "dark-cc",
  "packages": [
    "npm:pi-antigravity",
    "npm:pi-web-access",
    "npm:@juicesharp/rpiv-todo",
    "npm:pi-cc-header",
    "npm:pi-simplify",
    "npm:@llblab/pi-telegram",
    "git:github.com/eleqtrizit/pi-autohooks",
    "npm:@narumitw/pi-usage"
  ],
  "quietStartup": true,
  "clearOnStart": true,
  "tuiMode": "fullscreen",
  "hideThinkingBlock": true,
  "showHardwareCursor": true,
  "fullscreenScrollbar": "auto",
  "editorPaddingX": 1
}
```

To set a default model and provider, add them to `settings.json`:

```json
{
  "defaultProvider": "openrouter",
  "defaultModel": "anthropic/claude-3.7-sonnet"
}
```

### Subagent Models (`agents/*.md`)

Subagent profiles declare a `model:` field in their frontmatter. Update the `model:` line in `agents/scout.md`, `agents/worker.md`, or `agents/researcher.md` to point to your preferred provider/model.

---

## Prerequisites

- **Node.js**: 22.0.0+
- **Pi coding agent**: `@earendil-works/pi-coding-agent`
- **Optional**:
  - `tmux`: For running parallel subagents in background panes.
  - `jq`: For autohook payload parsing.
  - `libnotify-bin` (`notify-send`): For Linux desktop turn notifications.

---

## Directory Structure

```text
~/.pi/agent/
├── agents/                     # Subagent orchestration profiles (scout, worker, researcher)
├── autohooks/                  # Safety and notification hooks
│   ├── agent-stop/             # notify-on-stop.sh
│   └── pre-tool-use/           # read-before-edit.sh
├── extensions/                 # Core extensions and submodules
│   ├── cc-ui/                  # (Submodule) Claude Code spinner & cache counter
│   ├── interactive-subagents/  # (Submodule) Tmux subagent orchestration
│   ├── prompt-snippets/        # (Submodule) Interactive prompt snippets
│   ├── safe-bash-guard/        # (Submodule) Command safety guard
│   ├── arda-kilo-models.ts     # Kilo Code provider integration
│   ├── ask-user-question.ts    # Interactive user dialog
│   ├── goal.ts                 # Token-budgeted goal tracker
│   ├── prompt-editor.ts        # External editor trigger
│   ├── review.ts               # Git diff review integration
│   └── tools.ts                # Tool registration
├── npm/                        # Global agent package manifest
│   └── package.json
├── prompts/                    # Reusable prompt snippets (comments, discuss)
├── skills/                     # (Submodule) Curated agent skills
├── themes/                     # TUI color schemes (dark-cc, orange-dark)
├── LICENSE                     # MIT License
├── README.md                   # Documentation
├── settings.json               # Turnkey default settings
├── settings.json.example       # Annotated settings reference
├── SYSTEM.md                   # Primary system prompt (Elyndra)
└── tools.json                  # Active tool bindings
```

---

## License

[MIT](LICENSE)

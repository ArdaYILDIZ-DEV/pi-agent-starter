# pi-agent-starter

A turnkey starter kit and curated distribution for the [Pi coding agent](https://github.com/badlogic/pi).

It provides a ready-to-use environment bundling 18 modular agent skills, 4 interactive extensions, 6 standalone TypeScript extensions, 3 subagent orchestration profiles, desktop notification and safety hooks, curated themes, and engineering system prompt personas.

---

## Prerequisites

Before installing the starter kit, verify that your environment meets these requirements:

- **Node.js**: Version 22.0.0 or higher.
- **Pi coding agent**: Installed globally via `npm install -g @earendil-works/pi-coding-agent` (or via `fnm` / `pnpm`).
- **Optional system tools**:
  - `tmux`: Required for running parallel subagents in background panes (`interactive-subagents`).
  - `jq`: Required by the `read-before-edit` autohook to parse tool execution payloads.
  - `libnotify-bin` (`notify-send`): Required by the `notify-on-stop` autohook for Linux desktop notifications.

---

## Quickstart

### 1. Clone into `~/.pi/agent`

To install this starter kit as your global Pi configuration:

```bash
# 1. If you have an existing configuration, back it up first:
[ -d ~/.pi/agent ] && mv ~/.pi/agent ~/.pi/agent.bak

# 2. Clone this repository recursively with all submodules:
git clone --recursive https://github.com/ArdaYILDIZ-DEV/pi-agent-starter.git ~/.pi/agent
```

> **Note:** If you cloned without `--recursive`, initialize the submodules manually:
> ```bash
> cd ~/.pi/agent && git submodule update --init --recursive
> ```

### 2. Install NPM Extension Packages

The starter kit declares required global extension packages in `npm/package.json`. Install them into the agent environment:

```bash
cd ~/.pi/agent/npm
npm install
```

### 3. Configure Model Credentials

Authenticate directly from inside Pi using the `/login` interactive command:

```bash
pi
# Inside Pi:
/login
```

Alternatively, you can create `~/.pi/agent/auth.json` manually with your provider API keys:

```json
{
  "openrouter": "YOUR_OPENROUTER_API_KEY",
  "anthropic": "YOUR_ANTHROPIC_API_KEY",
  "openai": "YOUR_OPENAI_API_KEY"
}
```

### 4. Launch Pi

Run Pi from any terminal or project directory:

```bash
pi
```

---

## What is Included

### 1. Curated Skills (`skills/`)

Bundles 18 public, tested skills maintained in [`pi-skills-public`](https://github.com/ArdaYILDIZ-DEV/pi-skills-public):

| Skill | Description | Invocable |
|---|---|---|
| `apple-inspired-web-design` | Apple Human Interface Guidelines web design tokens, typography, and contrast rules | Automatic |
| `avoid-ai-design` | UI design audit to eliminate generic AI frontend tropes ("AI slop") | Automatic |
| `browsing-reddit` | Token-efficient compact Reddit reader using `rdt-tidy` | Automatic |
| `casual-internet-english-writer` | Direct writing and editing for forums, Reddit, and social media without corporate jargon | Manual |
| `comment-audit` | Standardized comment pruning across TS, JS, Python, Go, C, and shell | Automatic |
| `conventional-commit` | Conventional Commits 1.0.0 message drafting and verification | Automatic |
| `crafting-tasteful-interfaces` | Production-grade frontend design with intentional typography and color tokens | Automatic |
| `how-to-use-subagents` | Delegation and steering rules for Pi subagents in tmux | Automatic |
| `no-ai-slop-frontend` | Frontend template and style guidance to avoid AI design tells | Automatic |
| `pi-extension-development` | ExtensionAPI guidelines, widgets, and lifecycle hooks for Pi agent extensions | Automatic |
| `professional-english-writer` | Concise professional English for pull requests, bug reports, and technical docs | Manual |
| `research` | Multi-source web research with scoped queries and exact passage citations | Automatic |
| `tmux-orchestration` | Isolated background command execution in dedicated tmux sessions | Automatic |
| `verify` | Targeted verification with fail-first evidence, test runs, and exit codes | Automatic |
| `writing-great-agents-md` | Rules and constraints authoring for repository `AGENTS.md` instruction files | Automatic |
| `writing-great-prompts` | Prompt engineering principles, constraints, and delimiter formatting | Manual |
| `writing-great-readmes` | Evidence-based, audience-focused technical README authoring | Automatic |
| `writing-great-skills` | Agent skill authoring, progressive disclosure, and validation tooling | Automatic |
| `writing-great-system-prompts` | System prompt authority hierarchy, tool boundaries, and output contracts | Automatic |

### 2. Extensions (`extensions/`)

- **Submodule Extensions**:
  - [`pi-interactive-subagents`](https://github.com/ArdaYILDIZ-DEV/pi-interactive-subagents): Orchestrates specialized subagents (`scout`, `worker`, `researcher`) in background tmux panes with live status reporting and fire-and-forget steering.
  - [`pi-cc-ui`](https://github.com/ArdaYILDIZ-DEV/pi-cc-ui): Claude Code style progress spinner, token counter, and prompt cache hit counter.
  - [`pi-prompt-snippets`](https://github.com/ArdaYILDIZ-DEV/pi-prompt-snippets): Composable prompt snippet injector with interactive fuzzy selection.
  - [`pi-safe-bash-guard`](https://github.com/ArdaYILDIZ-DEV/pi-safe-bash-guard): Deterministic bash command inspection engine preventing destructive mutations outside approved scopes.
- **Standalone TypeScript Extensions**:
  - `arda-kilo-models.ts`: Lightweight Kilo Code OAuth provider integration enabling `/login` and dynamic model catalog discovery.
  - `ask-user-question.ts`: Interactive single-question prompt dialog with option selection.
  - `goal.ts`: Token-budgeted goal lifecycle tracking tool.
  - `prompt-editor.ts`: Opens current prompt input in external editor (`$EDITOR`).
  - `review.ts`: Interactive git diff review dialog before staging or committing changes.
  - `tools.ts`: Custom tool registration and execution primitives.

### 3. Subagent Personas (`agents/`)

- `scout.md`: Read-only reconnaissance specialist. Maps codebase architecture, finds function definitions, and traces call graphs without making changes.
- `worker.md`: Implementation worker. Carries out scoped edits, runs unit tests, and verifies output against acceptance criteria.
- `researcher.md`: Evidence-focused research specialist. Queries web sources, evaluates trade-offs, and synthesizes structured briefs.

### 4. Safety and Desktop Autohooks (`autohooks/`)

- `pre-tool-use/10-read-before-edit.sh`: Inspects edit/write tool calls and enforces that the target file has been inspected via `read` during the active session before any mutation is permitted.
- `agent-stop/20-notify-on-stop.sh`: Dispatches a desktop notification (`notify-send`) when Pi finishes generating its response or pauses for user input.

### 5. System Prompts & Engineering Personas

- `SYSTEM.md` (`Elyndra`): Core persona emphasizing instruction hierarchy, live observation over assumption, zero fabrication, fail-first verification, and concise communication without flattery or emojis.
- `Aster-Strategy-Deep.md`: High-level architectural planning and system design.
- `Caelum-Adversarial-Deep.md`: Red-teaming, adversarial edge-case analysis, and security auditing.
- `Kaida-Entertainment-Pocket.md`: Conversational and lightweight media analysis.
- `Liora-Companion-Deep.md`: Thought partnership and exploratory discussion.
- `Neris-Research-Deep.md`: Deep domain synthesis and literature review.

### 6. Themes & UI (`themes/`)

- `dark-cc.json`: Claude Code inspired high-contrast dark theme.
- `orange-dark.json`: Darkmatter warm orange dark theme.

---

## Configuration

### `settings.json`

The included `settings.json` activates the bundled extensions, UI polish, and plugins:

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

The subagent definitions in `agents/scout.md`, `agents/worker.md`, and `agents/researcher.md` specify a `model:` field in their frontmatter. If you do not have access to the default provider declared there, update the `model:` line to your active provider and model identifier:

```markdown
---
name: scout
model: openrouter/anthropic/claude-3.5-haiku
thinking: low
---
```

### Active Tools (`tools.json`)

`tools.json` controls which tools are enabled globally. Default tools include `bash`, `edit`, `write`, `read`, `ask_user_question`, `subagent`, `todo`, `create_goal`, and `web_search`.

---

## Maintenance and Updating

To pull the latest updates for all bundled skills and submodules from their respective repositories:

```bash
cd ~/.pi/agent
git pull
git submodule update --remote --merge
```

### Local Maintainer Sync (`scripts/sync-from-local.sh`)

If you maintain a private, active Pi configuration and wish to update this public starter repository without exposing sensitive credentials, run:

```bash
cd /path/to/pi-agent-starter
./scripts/sync-from-local.sh
```

The script copies updated agent profiles, autohooks, prompts, themes, system prompts, and standalone extensions while explicitly skipping `auth.json`, `telegram.json`, `models.json`, `trust.json`, `sessions/`, and local caches.

---

## Troubleshooting

### Submodules are empty folders after cloning
**Cause:** The repository was cloned without the `--recursive` flag.  
**Fix:** Run `git submodule update --init --recursive` inside `~/.pi/agent`.

### Autohook error: `Dosya bu oturumda okunmadı, önce Read ile oku`
**Cause:** `10-read-before-edit.sh` blocks editing or overwriting an existing file that the agent has not yet inspected with `read`.  
**Fix:** Ensure your prompt or agent reads the file before requesting an edit.

### Subagent fails to start: `tmux: command not found`
**Cause:** `tmux` is required to host isolated subagent panes.  
**Fix:** Install tmux using your package manager (`sudo apt install tmux` or `brew install tmux`).

### Packages fail to load on startup
**Cause:** Dependencies declared in `npm/package.json` have not been installed.  
**Fix:** Run `cd ~/.pi/agent/npm && npm install`.

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
│   ├── safe-bash-guard/        # (Submodule) Deterministic command safety engine
│   ├── arda-kilo-models.ts     # Kilo Code provider integration
│   ├── ask-user-question.ts    # Interactive user dialog
│   ├── goal.ts                 # Token-budgeted goal tracker
│   ├── prompt-editor.ts        # External editor trigger
│   ├── review.ts               # Git diff review integration
│   └── tools.ts                # Custom tool registration
├── npm/                        # Global agent package manifest
│   └── package.json
├── prompts/                    # Reusable prompt snippets (comments, discuss)
├── scripts/                    # Maintenance and sync helpers
│   └── sync-from-local.sh
├── skills/                     # (Submodule) 18 curated agent skills
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

[![npm version](https://img.shields.io/npm/v/%40axion-neuralis%2Faxion-ai-cli)](https://www.npmjs.com/package/@axion-neuralis/axion-ai-cli)
[![License: GPL v3 or later](https://img.shields.io/badge/License-GPLv3%2B-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D18.17-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![Platform](https://img.shields.io/badge/Platform-Termux%20%7C%20Linux%20%7C%20macOS-informational)](#requirements)

# AXION AI CLI


A terminal-based AI agent published by **AXION Neuralis**. AXION provides an interactive command-line interface, model-provider integration, tool calling, web search, page extraction, conversation history, and local long-term memory.

**npm package:** [`@axion-neuralis/axion-ai-cli`](https://www.npmjs.com/package/@axion-neuralis/axion-ai-cli)  
**Release target:** `1.0.2` — feature and reliability update

> AXION is an API-backed CLI application. You must provide credentials for the selected model provider before chatting.


## Features

- **Normal scrolling terminal chat** with a single persistent input prompt, animated thinking indicator, arrow-key navigation, inline `/` command autocomplete, and English/Indonesian interface text. First launch displays the command help automatically.
- **Google AI Studio / Gemini API** provider using the Gemini `generateContent` endpoint.
- **OpenAI-compatible** chat-completions provider for compatible API services.
- **Custom providers**: add and persist multiple OpenAI-compatible providers (unique id, name, base URL, API key, optional default model) via `/provider`. Switching to a custom provider auto-loads its credentials — no re-entry. API keys are masked in output (last 4 characters only).
- **Tool calling** through a controlled registry: web search, page extraction, local shell execution, and filesystem tools (`list_dir`, `read_file`, `write_file` atomic, `delete_file`).
- **Step-by-step UI**: tool calls are classified into human-readable steps (Reading / Editing file / Deleting file / Running tests / Building / Running command). File changes show a summary + path + status, not raw content. `/verbose` toggles full output vs summaries (default: summaries).
- **Dangerous-action policy**: `rm -rf`, `git push`/`--force`, `sudo`, `mkfs`, `dd`, system-file overwrite, `curl|bash`, and similar commands are gated by a persistent policy (default: Always Ask, with explicit Yes/No confirmation; or Always Allow / Always Deny).
- **ESC to cancel**: press Escape while the agent is working to stop safely — in-flight HTTP requests are aborted and shell child processes are terminated; a partial result is returned.
- **Locked base system prompt** vs user-editable **custom instructions** (`/instructions`). Core rules (anti-hallucination, security, no fabrication) take precedence over conflicting custom instructions. `/system` and `/system-prompt` are read-only views.
- **Conversation storage** with open, delete, and JSON backup operations (buffered in memory per session, flushed at session boundaries).
- **Local long-term memory** that can be added, summarized, listed, edited, renamed, and removed.
- **Permission and access-scope controls**. Shell execution is enabled by default for fresh configurations; the agent can be set to workspace-policy or global scope.
- Designed for **Termux and Unix-like environments** with Node.js 18.17 or newer. `axion-ai-cli` is the canonical command; `axion-cli` and `axn-cli` remain compatibility aliases.

## Requirements

- Node.js **18.17.0 or newer**.
- npm (normally bundled with Node.js).
- A Google AI Studio API key or credentials for an OpenAI-compatible provider.
- Internet access for package installation and remote model/search/page requests.

On Termux, install Node.js with:

```sh
pkg update
pkg install nodejs
```

## Installation

### Recommended: global installation

Install the published package directly from npmjs:

```sh
npm install -g @axion-neuralis/axion-ai-cli
```

Then start the CLI:

```sh
axion-ai-cli
```

The compatibility commands `axion-cli` and `axn-cli` are also provided. If your npm global binary directory is not in `PATH`, check `npm prefix -g` and add its `bin` directory to your shell profile.

### Install as a project dependency

```sh
npm install @axion-neuralis/axion-ai-cli
npx axion-ai-cli
```

### Update

```sh
axion-ai-cli update
```

The updater installs the latest published package through `https://registry.npmjs.org/`. To inspect the installed and latest versions without changing the installation, run `axion-ai-cli update --info`. For a project-local install, update the dependency with `npm install @axion-neuralis/axion-ai-cli@latest`.

### Optional installer script

The repository's `install.sh` is a small npmjs bootstrapper. When you already have a local copy of this repository, run:

```sh
bash install.sh
```

It does not clone GitHub source or build the project; it delegates installation to npmjs.

### Install from source (contributors)

```sh
git clone https://github.com/azrielspace852-wq/axion-ai-agents-cli.git
cd axion-ai-agents-cli
npm ci
npm run build
node dist/index.js
```

## First run

Start the application:

```sh
axion-ai-cli
```

Set an API key from the interactive prompt:

```text
/api-key
```

The API key is requested without terminal echo and saved in the local configuration file. The configuration file is stored as a local plaintext file protected by restrictive filesystem permissions; it is not encrypted. Protect access to your operating-system account and backups.

To select another provider, use `/provider`. For an OpenAI-compatible provider, enter its base URL (for example, `https://api.openai.com/v1`) and API key. The provider must implement the OpenAI Chat Completions API and tool-calling format used by this CLI. You can also add multiple persistent custom providers in the same menu — credentials are saved and reloaded automatically on switch.

## Commands

AXION runs as a normal scrolling terminal chat: AI replies print above a single persistent input prompt. Typing `/` at the start of a line opens an inline command-suggestion popup (ArrowUp/ArrowDown to navigate, Enter to fill the highlighted command, Esc to dismiss). Set `AXION_NO_AUTOCOMPLETE=1` to disable the popup (useful for scripting). The old full-screen/alt-screen mode and bottom-anchored input frame are not used.

### Terminal commands (without entering chat)

| Command | Description |
|---|---|
| `axion-ai-cli` (no args) | Enter interactive chat mode. `axion-cli` and `axn-cli` are compatibility aliases. |
| `axion-ai-cli --help` / `-h` | Show full help: terminal + in-chat commands. |
| `axion-ai-cli --version` / `-v` | Print the installed version (from `dist/version.json`). |
| `axion-ai-cli --feedback` | Show support contacts, then enter chat. |
| `axion-ai-cli update --info` | Read the latest version from npmjs and show update instructions without installing. |
| `axion-ai-cli update` | Install the latest published package using npm and the official npmjs registry. `AXION_UPDATE_DRY_RUN=1` prints the command without running it. |

### In-chat commands (type inside the REPL)

| Command | Description |
|---|---|
| `/help` | Show available commands. |
| `/models` | Select/add/edit/delete models; lists only models of the active provider. Built-in models cannot be deleted. |
| `/provider` | Switch provider or manage custom providers (list/add/edit/delete/select). Custom providers persist and auto-load credentials. |
| `/api-key` | Set or update the active provider's API key. |
| `/thinking` | Configure the requested reasoning level (off/low/medium/high/max). Actual support depends on the selected model. |
| `/system` | View the locked base system prompt (read-only). |
| `/system-prompt` | View the locked base system prompt + current custom instructions (read-only). |
| `/instructions` | Set or clear your custom instructions (appended to the base prompt; core rules take precedence on conflict). |
| `/verbose` | Toggle verbose output (full tool output / diffs vs summaries; default: summaries). |
| `/memory` | List, add, edit entries, rename topics, delete entries/topics, or clear memory. |
| `/permissions` | Enable or disable agent tools and local access permissions. |
| `/access` | Choose workspace-only or global agent access policy (`/acces` remains a compatibility alias). |
| `/tool-limit` | Configure an optional per-request tool-call budget (`0` = unlimited, the default). A positive safe integer enables a budget. `/max-tool-call` is an alias. |
| `/max-token` | Set an optional input-token soft cap (honest chars/4 estimate, oldest non-system messages trimmed first) and an output-token cap forwarded to the provider. |
| `/privacy-policy` | Show honest security & privacy information (local storage, what is sent to providers, no AXION telemetry, risks, controls). |
| `/feedback` | Show AXION support email addresses and the GitHub issue tracker. |
| `/conversation` | Open, delete, back up, or create a conversation. |
| `/language` | Switch the interface language between English and Indonesian. |
| `/clear` | Clear the screen and current in-memory chat context. Saved history remains on disk. |
| `/exit` | Exit the application. |

## Language and CLI interaction

The `/language` command switches the supported interface locales (English and Bahasa Indonesia) at runtime. Command prompts, menu choices, status text, feedback text, terminal help, and the in-chat command interface update to the selected locale; tool results, model responses, file contents, provider names, model IDs, and shell output remain in their original language. The selected language is persisted in the local configuration.

## Tools and permissions

| Tool | Purpose | Permission |
|---|---|---|
| `google_search` | Search the web using Google with DuckDuckGo fallback. | `searchAccess` |
| `web_scrape` | Retrieve readable text from an HTTP(S) web page. | `webAccess` |
| `run_shell` | Run a command in the local operating-system shell. | `shellExec` |
| `list_dir` | List directory contents (with file counts). | `fileRead` |
| `read_file` | Read one text file (large files truncated with a note). | `fileRead` |
| `get_workspace_tree` | Explicitly request a workspace folder tree without file contents. Common generated/dependency folders are excluded by default; symlinks are not followed. | `fileRead` |
| `read_files` | Explicitly read a selected list of files or all text files (`all: true`) with a bounded total-output budget (1 MiB default / 10 MiB maximum), discovery cap (10,000 default / 50,000 maximum), and 1,000 explicit-path cap. Binary files and symlinks are skipped. | `fileRead` |
| `write_file` | Create or overwrite a file atomically (temp file + rename). Overwriting an existing file is a dangerous action and may require confirmation. | `fileWrite` |
| `delete_file` | Delete a file. A dangerous action requiring confirmation unless policy allows. | `fileWrite` |

`run_shell` is **enabled by default on fresh configurations**, as requested. It executes commands with the permissions of the current operating-system user. Review generated commands carefully and disable `shellExec` with `/permissions` if you do not want local command execution. Existing configurations that explicitly saved `shellExec: false` keep that choice.

### Dangerous-action policy
Dangerous commands — `rm -rf`, `git push` (including `--force`), `sudo`, `mkfs`, `dd`, overwriting system files, piping a remote script to `shell`, and similar — are gated by a persistent policy configurable in `/permissions`:
- **Always Ask** (default): the CLI pauses and asks for explicit Yes/No confirmation before executing.
- **Always Allow**: dangerous actions execute without prompting (use with caution).
- **Always Deny**: dangerous actions are blocked entirely.

Overwriting an existing file via `write_file` and any `delete_file` are also treated as dangerous and follow the same policy. When no confirmation channel is available (non-interactive), dangerous actions are refused by default.

The `/access` command (with `/acces` retained as a compatibility alias) controls the agent policy and the shell tool working-directory restriction. Workspace scope checks the requested shell working directory, but it is **not an OS-level sandbox**: arbitrary shell commands can still access paths available to the current OS user. Do not treat workspace scope as a security boundary. Global scope tells the agent that broader filesystem operations are allowed when otherwise permitted.

## Model selection

The built-in Google model list includes the following model IDs:

- `gemma-4-31b-it`
- `gemma-4-26b-a4b-it`
- `gemini-3.8-flash`
- `gemini-3.5-flash`
- `gemini-3.5-flash-lite`
- `gemini-3.1-flash-lite`

Model availability and capabilities can vary by account, API access, lifecycle status, and provider. The model list is a convenience list, not a guarantee that every model is enabled for every API key. Custom models can be added, edited, or deleted with `/models`; deletion is limited to user-defined models. Each custom model supports a display name, provider model ID, and a registered provider association. Adding a model offers the active provider by default and only lists providers already registered in AXION; selecting another listed provider explicitly switches the active provider. Models cannot reference an unknown/unregistered provider. OpenAI-compatible built-in models may also use an optional model-specific base URL.

For Gemini 3 models, AXION sends the documented `thinkingLevel` field when a reasoning level is selected and omits sampling parameters so the provider defaults are used. Gemma 4 has a binary thinking switch: `off` maps to `MINIMAL` and any enabled level maps to `HIGH`. Gemini 2.5 uses `thinkingBudget`. The `off` option sets a zero budget for Gemini 2.5 Flash / Flash-Lite; Gemini 2.5 Pro and Gemini 3 do not expose a full thinking-off setting through this API, so `off` leaves the provider default in effect for those models. OpenAI-compatible providers may ignore the thinking setting.

## Custom providers
In addition to the built-in Google AI Studio and OpenAI-compatible providers, you can add any number of persistent custom OpenAI-compatible providers via `/provider` → *Add custom provider*. Each custom provider has a unique id (slug), a display name, a base URL, an API key, and an optional default model. Custom providers are stored in `~/.axn-cli/config.json` (mode 0600) and survive restarts. When you select a custom provider as active, its base URL, API key, and default model load automatically — you do not re-enter credentials. API keys are never printed in full; output shows only the last 4 characters (`****abcd`). Use `/provider` to list, add, edit, delete, or select custom providers.

## Step-by-step UI and verbose mode
While the agent works, tool calls are classified into human-readable steps and announced via the status line: *Reading*, *Editing file*, *Deleting file*, *Running tests*, *Building*, or *Running command*. File changes report a short summary (path + status: created/modified/deleted + byte count), not the full file content. Toggle full output (raw tool results and diffs) with `/verbose`; the default is summaries-only.

## ESC to cancel
Press **Escape** while the agent is thinking or executing tools to request cancellation. The CLI sets a cancellation flag, aborts in-flight HTTP requests (via `AbortController`), and terminates in-flight shell child processes (SIGTERM). The tool-call loop checks the flag between iterations and returns a partial result with a `(cancelled by user)` note. Configuration writes are atomic (temp file + rename), so cancellation cannot corrupt `config.json`. If a provider does not honour the abort mid-response, the loop stops at the next iteration (graceful stop); this limitation is documented in `CATATAN.md`.

## System prompt vs custom instructions
The **base system prompt** (anti-hallucination, workspace awareness, execution transparency, terminal guardrails, and loop/resource safety) is **locked** — it cannot be edited by the user. Your own additional instructions live in **custom instructions**, edited with `/instructions` (legacy `systemPrompt`/`instructions` fields in old configs are migrated automatically on load). The editor accepts newlines with Enter; press **Ctrl+X**, then **Y** to save or **N/Esc** to cancel. Press **Ctrl+A** to clear the editor. The base prompt explicitly states that core rules always take precedence over custom instructions. Use `/system` or `/system-prompt` to view the locked base prompt and your current custom instructions (read-only).


## Local data and configuration

By default, AXION stores settings, conversations, and memory under:

```text
~/.axn-cli/
├── config.json
├── conversations/
└── memory/
```

Set `AXION_DATA_DIR` before starting the CLI to use a different data directory. Application files and user data are stored separately. Updating or reinstalling the application does not intentionally remove the data directory.

The configuration file contains provider credentials (including custom providers), custom instructions, dangerous-action policy, verbose preference, and permission settings. It is stored locally as plaintext, with restrictive directory and file permissions (0600) where supported by the operating system. Do not share it publicly.

## Development and validation

```sh
npm ci
npm run build
npm test
```

`npm test` builds the TypeScript project and runs the local Node.js test suite. Tool calls are unlimited by default (`maxToolCallsPerRequest: 0`); `/tool-limit` can set an optional positive per-request budget. An identical tool+arguments signature is blocked on its third occurrence, after which AXION asks the provider for a final response without tools. No workspace tree or file contents are sent automatically: the agent must request `get_workspace_tree`, `read_file`, or `read_files` as needed. `read_files` can read an explicit list or the full text-file set (`all: true`) within its configurable output-byte budget; the default is 1 MiB and the maximum is 10 MiB, with file-count and traversal-depth ceilings. Complex work is governed by explicit task planning, execution guardrails, and post-change verification. Tests mock provider requests and do not call live model APIs or external search services. A real inference check requires valid provider credentials and network access.

## Troubleshooting

**`axion-ai-cli: command not found`** — Add the npm global binary directory (under `npm prefix -g`) to your `PATH`, then restart your shell or source the relevant profile.

**`No API key configured`** — Run `/api-key`, or switch provider with `/provider` and configure the matching key.

**HTTP 400 / model not found** — Check the model ID, account access, and whether that model supports the `generateContent` endpoint. Use `/models` to select another model or add a provider-supported custom ID.

**Search returns no results** — Search engines may rate-limit or change their HTML layout. Retry later; this feature does not use an official Google Search API.

**Installation fails** — Check that Node.js is 18.17 or newer, npm is available, the `@axion-neuralis` npm scope is accessible to your account, and `https://registry.npmjs.org/` can be reached. For a permission error during global installation, configure a user-owned npm prefix or use a local project installation.

## License

AXION AI CLI is licensed under the **GNU General Public License v3.0 or later**. See [LICENSE](LICENSE) for the complete license text.

---

Developed by **AXION Neuralis**.

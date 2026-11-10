# Changelog

## 1.0.2 — 2026-11-09

### Added
- Unlimited-by-default tool-call execution (`maxToolCallsPerRequest: 0`) with an optional per-request budget configurable through `/tool-limit`.
- Repeated-call loop guard: an identical tool name + normalized arguments signature is executed at most twice per request; the third request is blocked and AXION is asked for a final response without tools.
- Explicit workspace context tools: `get_workspace_tree` for directory structure and `read_files` for selected files or all text files within a configurable output-byte budget.
- Multiline custom-instructions editor: Enter inserts a newline; Ctrl+X starts confirmation; Y saves; N/Esc cancels; Ctrl+A clears the editor. Non-TTY input uses `:save` / `:cancel`.
- Runtime English / Bahasa Indonesia localization for command prompts, menu choices, and command feedback, with locale dictionary parity checks.
- Custom-model provider association by registered provider ID, including custom providers.
- Capability-aware hard-rule system prompt describing available tools, file-context request flow, terminal approval guardrails, and verification expectations.

### Fixed and improved
- Removed the hard-coded tool-iteration cutoff that could stop an otherwise valid multi-step workflow.
- Removed automatic workspace tree injection from the system prompt; workspace file contents are only sent after explicit tool requests.
- Resolved final-path symlinks before access-scope checks and blocked unresolved symlink targets to prevent workspace-scope escapes.
- Kept creation of new files in nested directories working when intermediate directories do not yet exist.
- Prevented custom models from silently changing provider context; unregistered provider associations are rejected during config normalization.
- Updated the privacy summary to reflect the explicit file-context model.
- Corrected the npm latest-version metadata URL to use the actual `@axion-neuralis` package scope.
- Redacted sensitive shell-command output before placing it into model conversation history.
- Updated `/language` to refresh the REPL prompt immediately after switching locales.

### Documentation and release
- Updated README, audit notes, version manifests, user notes, and package metadata to version `1.0.2`.
- Added `TASK_LIST.md` and `TASK_CHECKLIST.md` to track the requested work and its local verification status.

## 1.0.0 — Final npmjs Release

- Initial public package release metadata and npmjs installation/update flow.
- Interactive terminal AI agent with Google AI Studio and OpenAI-compatible providers.
- Tool calling, web search and page extraction, local conversations, summarized long-term memory, permissions, custom providers, and update checks.

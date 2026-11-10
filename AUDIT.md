# AXION AI Agents CLI — v1.0.2 Engineering Audit

## Release identity

- Package: `@axion-neuralis/axion-ai-cli`
- Release target: `1.0.2`
- Canonical command: `axion-ai-cli`
- Compatibility commands: `axion-cli`, `axn-cli`
- Registry configured in package metadata: `https://registry.npmjs.org/`
- License: `GPL-3.0-or-later`

The project source, npm metadata, lockfile root metadata, runtime version manifests, banner, documentation, and generated `dist/` output are aligned to `1.0.2`.

## Audit findings and corrective actions

| Area / location | Finding, cause, and impact | v1.0.2 correction |
|---|---|---|
| `src/agent/Agent.ts` tool loop | A fixed per-request iteration ceiling could terminate a valid multi-step task before the provider completed it. | Removed the fixed loop ceiling. Tool calls are unlimited by default; `maxToolCallsPerRequest: 0` means unlimited and positive values enable an optional per-request budget. |
| `src/agent/Agent.ts` loop control | Unbounded execution without a guard could permit repeated identical calls and waste tokens/resources. | Added normalized tool-name/arguments signature tracking. An identical signature may execute twice; the third occurrence is blocked and the agent is asked for a final response without tools. This detects exact repeats, not every possible semantic loop. |
| `src/agent/Agent.ts` system prompt | The initial prompt automatically attached a workspace tree, contrary to the requested on-demand context strategy. | Removed automatic tree injection. The prompt instructs the model to request `get_workspace_tree`, `read_file`, or `read_files` explicitly. |
| `src/agent/tools/FileSystemTools.ts` path resolver | The final target was not consistently canonicalized before workspace-scope checks. A symlink could therefore create an escape path. | Canonicalize existing targets and nearest existing ancestors; block out-of-workspace targets and unresolved final symlinks. Recursive scans and `read_files` do not follow symbolic links; `get_workspace_tree` also rejects a symlink as its requested root path. |
| `src/agent/tools/FileSystemTools.ts` context reading | A broad `all=true` request could scan/read too much data and allocate large buffers. | Added default/maximum output budgets (1 MiB / 10 MiB), discovery limits (10,000 default / 50,000 maximum), explicit path cap (1,000), depth cap (100), binary-file skipping, ignored-directory exclusions, and bounded single-file reads. |
| `src/commands/handlers.ts` custom models | A custom model could be represented only by transport type (`openai-compatible`), losing its exact custom-provider identity. Selecting it could activate the wrong provider. | Added `providerId` association, explicit provider choice, registered-provider validation, credential/endpoint checks, and exact provider activation on model selection. Added display-name and model-ID validation. |
| `src/config/ConfigManager.ts` configuration normalization | Unknown custom-provider IDs could remain attached to model configuration. | Drop custom models associated with unregistered providers or mismatched transport types during normalization; reject persisted custom-provider endpoints that are not credential-free HTTP(S) URLs. Preserve existing configuration and legacy instruction migration. |
| `src/commands/handlers.ts` + `src/repl/REPL.ts` instructions editor | The previous editor accepted a single line and Enter effectively completed input, making multiline instructions impractical. | Added TTY multiline editing: Enter inserts a newline; Ctrl+X opens confirmation; Y saves; N/Esc cancels; Ctrl+A clears. Non-TTY mode uses `:save` and `:cancel`. |
| `src/i18n/index.ts`, `src/repl/REPL.ts`, command handlers, `src/index.ts` | Runtime language switching covered only part of the CLI, leaving prompts, menus, statuses, feedback, and terminal help in English. | Expanded English/Indonesian UI phrase coverage, translated command-boundary prompts and choices, refreshed the prompt after switching language, and made `--help` read the saved locale. Tool data, shell output, file contents, provider names, and model responses are intentionally not translated. |
| `src/index.ts` package metadata lookup | The latest-version lookup URL did not consistently encode the scoped npm package identity. | Use the exact `@axion-neuralis/axion-ai-cli` registry endpoint and validate the returned package name. |
| `src/agent/Agent.ts` shell history | Sensitive-looking shell output could be copied directly into model history. | Apply output redaction to shell command notices and shell results before adding them to conversation history. |
| `README.md` command reference | The `/acces` spelling was presented as the primary access command even though `/access` is the canonical route. | Document `/access` as primary and `/acces` as a compatibility alias. |

## Unlimited-tool-call definition

“Unlimited” means AXION no longer stops an otherwise valid task at a fixed total number of tool calls. By default, the per-request budget is `0` (unlimited). A user may configure a positive budget with `/tool-limit`. To prevent one exact repeated action from running forever, AXION tracks a stable serialization of the tool name and arguments; the same signature is allowed twice and blocked on its third occurrence. Different arguments or changed state are not automatically classified as the same call. This is a loop guard, not a general semantic-loop detector; users should still configure a positive budget for workloads that need a hard resource ceiling.

## Security and operating assumptions

- File-read tools require `fileRead`; file-write/delete tools require `fileWrite`.
- Workspace path checks apply to the file tools and the shell tool's requested working directory.
- **Workspace scope is an agent policy, not an operating-system sandbox.** Arbitrary shell commands can still access paths available to the current OS user.
- Destructive shell actions, file overwrites, and deletions follow the configured dangerous-action policy. When confirmation is unavailable under `always-ask`, the operation is refused.
- The prompt instructs the model to inspect tree/file context before making claims about unseen source, log actions, request approval for risky operations, and verify changes before reporting completion.
- Explicit `read_files` requests are bounded. The all-files mode skips `.git`, `node_modules`, caches, coverage, and Python cache folders by default; users can opt in to ignored folders while remaining subject to the hard scan/output ceilings.

## Local validation record

Environment: local isolated project workspace; Node.js `v22.16.0`, npm `10.9.2`, global TypeScript compiler `5.8.3`.

| Check | Result | Detail |
|---|---|---|
| `npm ci --ignore-scripts --no-audit --no-fund` | **Blocked by environment** | The dependency installation attempt timed out; this environment could not complete a clean npm dependency download. |
| `npm run build` | **Passed (offline-assisted)** | TypeScript compilation and dist metadata copy completed using temporary local declaration/runtime shims for unavailable third-party packages. These validation-only shims are excluded from the release archive. |
| `node --test tests/*.test.cjs` | **Passed** | 45 tests passed, 0 failed, 0 skipped. Provider HTTP behavior is mocked in tests; no live provider endpoint is called. |
| Pseudo-terminal editor check | **Passed** | Save with Ctrl+X/Y, cancel with Ctrl+X/N, cancel with Ctrl+X/Esc, and cancel during editing with Esc all produced the expected saved string or `null`. |
| `node dist/index.js --version` | **Passed** | Prints `1.0.2`. |
| `--help` locale smoke test | **Passed** | Unit test confirms stored Indonesian locale yields Indonesian terminal and in-chat help labels. |
| Live model inference | **Not run** | No provider credentials/network-backed inference was available in this environment. Mocked provider tests are not proof of live inference. |
| `npm pack --dry-run --json --ignore-scripts` | **Passed** | Reports `@axion-neuralis/axion-ai-cli@1.0.2`, 32 package files, expected runtime/docs, and no temporary shims or `node_modules`. |

The build/test result is a local regression result, not evidence that a clean dependency install with every pinned npm package completed. The temporary shims were used only inside the working directory to compile and run mocked tests; they must not be included in the release archive.

## Release readiness and remaining limitation

Implementation and offline regression checks are complete for the requested code paths. Task 8 remains partially verified because clean dependency installation and live provider inference could not be completed in this environment. Do not describe live inference or clean installation as verified until those checks pass in an environment with npm registry access and valid provider credentials. Preparing the ZIP does not publish the package to npm.

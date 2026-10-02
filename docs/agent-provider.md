# Agent provider

The comprehension pass runs an agent CLI and turns its answer into a validated `ReviewGraph`.
The host only sees `AgentProvider` (`src/agent/provider.ts`); `createProvider` (`src/agent/index.ts`)
picks the implementation. Today there is one: `ClaudeCliProvider` (`src/agent/claudeCli.ts`).

We call the **CLI**, not an SDK, so the user's existing login (subscription, API key, company SSO,
Bedrock/Vertex settings) is inherited and Filos never touches credentials.

## How `claude` is invoked

`child_process.spawn` with an argument array (no shell), `cwd` = the repo with the head revision
checked out. The PR prompt goes on **stdin**: there is no argv size limit, and the diff doesn't appear
in the process list. (`promptVia: 'argv'` puts it after `--` instead; both are covered by tests.)

```
claude -p
  --output-format stream-json --verbose     progress lines while it works; the last line is the result
  --json-schema <contract schema>           structured output, see "Schema" below
  --append-system-prompt <contract prompt>  src/agent/prompt.ts: how to build the graph, field by field
  --tools=Read,Grep,Glob                    read the repo for context; never Bash, Edit or Write
  --permission-mode dontAsk                 never block on a prompt; anything not pre-approved is denied
  --strict-mcp-config                       no MCP servers
  --setting-sources user                    the user's settings only: the repo's .claude/ settings come
                                            from the PR under review and could add hooks
  --no-session-persistence                  don't litter the user's session history
  --max-budget-usd <filos.claude.maxBudgetUsd>
  [--model <filos.claude.model>]
```

Defence in depth: the CLI's `init` message lists the tools it offers. If it lists any of `Bash`,
`Edit`, `Write`, `MultiEdit`, `NotebookEdit`, `PowerShell` or `REPL` (a CLI that ignored `--tools`),
we kill it before it does anything and report `failed`.

Variables a parent Claude Code session sets for its children (`CLAUDECODE`, `CLAUDE_CODE_SESSION_ID`,
`CLAUDE_CODE_SDK_HAS_HOST_AUTH_REFRESH`, ...) are removed from the child's environment, in case VS Code
itself was started from inside a Claude Code session. Auth variables (`ANTHROPIC_*`,
`CLAUDE_CODE_USE_BEDROCK`, ...) pass through.

**Process control.** `filos.agentTimeoutSeconds` and the request's `AbortSignal` kill the whole
process group (SIGTERM, then SIGKILL after 2 s; `taskkill /T` on Windows), so tool processes die too.
stdout is processed line by line and never held in full: one line may be up to 32 MiB and the whole
stream up to 256 MiB, beyond which the run is stopped.

**Progress.** Tool calls in the stream become `onProgress` messages for the loading view:
"Reading money/round.ts", "Searching for "roundToCents"", "Thinking about how the pieces fit…".

## Schema

`--json-schema` gets `schema/review-graph.schema.json` after `toCliSchema` (`src/agent/schema.ts`):
local `$ref`s inlined, `const` turned into a one-value `enum`, `$schema`/`$id`/`definitions` and
the provider-owned `generatedBy` removed. With Claude Code 2.1.276 the converted schema, including
`minLength`/`maxLength`/`minimum`, was accepted as-is (the CLI exposes it as a `StructuredOutput` tool).

The answer is **never trusted**: `structured_output` (or, failing that, JSON found in the text answer,
fenced or bare) goes through `validateGraph` with a reader confined to the repo, so anchors and
outline regions are checked against the real line counts. `pr` is overwritten with what the host
asked for, and `generatedBy` is filled in as `{provider: "claude", model, at}`, with `model` taken
from the CLI's `init` message (the resolved name, e.g. `claude-sonnet-5`, not the alias).

## Errors

Every failure is a `ProviderError` with a `kind` the UI can act on and the raw text in `detail`.

| kind | When |
|---|---|
| `notInstalled` | spawn fails with ENOENT/EACCES |
| `authExpired` | the result or stderr says: not logged in, `/login`, invalid API key, OAuth token expired / failed to refresh, `authentication_error`, 401, unauthorized; or `claude auth status` reports `loggedIn: false` |
| `budget` | result subtype mentions budget (`error_max_budget_usd`) |
| `contract` | `error_max_structured_output_retries`, no JSON in the answer, or `validateGraph` errors (joined in `detail`) |
| `timeout` | `timeoutSeconds` elapsed |
| `cancelled` | the request's `AbortSignal` fired |
| `failed` | anything else (rate limits, overload, crashes, forbidden tools), with the first line of the error as message |

The transient "Failed to refresh OAuth token: another Claude Code process is refreshing it…" error is
`authExpired` too; its `detail` says to retry in a minute, which the error view can show as is.

`checkReady()` runs `claude auth status` (fast, no API call) and throws `notInstalled` or
`authExpired`. `loginCommand` is `<claude path> auth login`.

## Testing

- `npm run test:unit` runs the provider against `test/fixtures/fake-claude` in every mode (see its
  README). Point `filos.claude.path` at `test/fixtures/fake-claude/claude` for e2e.
- `npx tsx scripts/smoke-claude.ts --model sonnet --budget 0.5` runs one real pass over the fixture
  repo and prints cost, duration, tools offered and the validated graph (it writes the transcript to
  a temp dir). It costs real money: about $0.14 and 50 s with Sonnet on 2026-10-03.

## Adding Codex (or another CLI)

1. Write `src/agent/codexCli.ts` implementing `AgentProvider`. Reuse `runProcess` (`exec.ts`) for
   spawning, timeouts and cancellation, `buildPrompt` (`prompt.ts`) for the prompt, `toCliSchema`
   for the schema, and `validateGraph` + `repoReader` for validation. Only the argv, the output parsing
   and the error patterns are CLI-specific.
2. Map Codex's equivalents: non-interactive exec mode, read-only sandbox, no approvals, JSON output
   against a schema file, and its own login check for `checkReady`.
3. Add `'codex'` to `ProviderConfig.id`, a case in `createProvider`, and the `filos.provider` enum.
4. Write a fake for it beside `test/fixtures/fake-claude` and run the same mode tests.

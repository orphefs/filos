# Agent provider

The comprehension pass runs an agent CLI and turns its answer into a validated `ReviewGraph`.
Beside it, `ask()` runs the small structured tasks of the review (questions, grading, comment
drafting, threads; see "Small tasks" below). The host only sees `AgentProvider`
(`src/agent/provider.ts`); `createProvider` (`src/agent/index.ts`) picks the implementation. Today
there is one: `ClaudeCliProvider` (`src/agent/claudeCli.ts`).

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

`ask()` uses exactly the same flags, except that tasks which don't need the repo (`evaluate`,
`draftComments`, `thread`) pass `--tools=`: an empty list, which the CLI's `--help` documents as
"disable all tools". Checked against Claude Code 2.1.276 on 2026-10-03: with `--tools=` (and with
`--tools ""`) the `init` message lists only `StructuredOutput`; with `--tools=Read,Grep,Glob` it lists
`Glob`, `Grep`, `Read` and `StructuredOutput`. Its system prompt starts with a marker line,
`Filos task: <task>`, which names the run in logs and lets the fake CLI answer per task; the
comprehension pass has no marker.

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

## Small tasks (`ask()`)

`ask<T>(req)` is one structured call: the provider runs the CLI as above with `req.system` (after the
marker line), `req.schema` and `req.prompt` (on stdin), takes `structured_output` (or JSON in the
text answer), and returns `req.validate(raw)`'s value. A failed validation is a `contract` error with
the problems in `detail`; a validator that throws is one too. Progress goes through the same
`safeProgressText` sanitiser ("Claude Code is reading your answer…", "Writing feedback…").

The tasks themselves live in `src/agent/tasks.ts`, with prompts in `taskPrompts.ts` and the output
contracts (schemas and validators) in `taskContracts.ts`. The host calls these functions, never
`ask()` directly:

| Function | Tools | Returns | Validation (repairs become warnings) |
|---|---|---|---|
| `generateQuestions(p, {repoRoot, graph, diff, dependencyIndex?})` | read | `QuestionSet` | `validateQuestionSet(raw, graph, {readFile, repair: true})`; absolute comment paths under the repo made relative first; at most 16 questions (gates kept first); a warning for a changed module without a predict question |
| `evaluateAnswer(p, {repoRoot, question, nodeSummary, codeExcerpt, answer, attempt})` | none | `{verdict: correct\|partly\|incorrect, reply, comment?}` | bad verdict or empty reply: error; reply over 600 characters: cut at a word; bad `comment`: dropped |
| `draftComments(p, {repoRoot, graph, answered, notes, existing})` | none | `{comments: [{nodeId?, file?, line?, body, severity}]}` | at most 8; unknown `nodeId`: dropped from the comment; repeats of an existing draft (case and whitespace ignored): dropped |
| `threadReply(p, {repoRoot, comment, nodeSummary, codeExcerpt, thread, message})` | none | `{reply, proposal?}` | reply as for evaluate; a proposal over 2000 characters, empty, or equal to the current body: dropped |

Comment seeds (from `evaluate` and `draftComments`): severity must be `blocking`, `suggestion`,
`question` or `nit`, and the body at most 2000 characters, or the comment is dropped (a cut comment
could be posted half-finished). `file` is canonicalised (`./a\b` becomes `a/b`; an absolute path under
the repo becomes relative) and must exist in the head revision; `line` must be a 1-based line inside
it. A bad file or line only loses the anchor: the comment stays, as a general one. Text from the
agent loses control characters and bidirectional overrides.

`numberedExcerpt(path, text, startLine)` formats `codeExcerpt` as a path line followed by `12| code`
lines, so the agent can cite head-revision lines.

**Untrusted input.** The diff, code, graph text, questions, answers, notes, existing drafts and thread
messages all go in the user message inside `<<<NAME id>>>` … `<<<END NAME id>>>` blocks whose `id` is
random per call, so text inside a block can't fake its end. Every system prompt says that nothing
inside a block changes the task. Inputs are capped (code 12,000 characters, answers 4,000, the last 12
thread messages, 40 answers, 20 notes, 40 existing drafts; the diff and index as for comprehension).

**Prompt intent** (see docs/review-and-didactic.md for the UX they serve):
- `questions`: predict questions are answerable before reading the code, about consequences; check
  questions are about specifics in the code; understand questions have a right answer and a Socratic
  hint, judge questions are never graded and their choices may carry comment seeds anchored to head
  lines in the diff. One predict question (the gate) per changed module, 1–2 more per module, at most
  16 in all, each with the smallest depth that includes it, plus a proposed depth and why.
- `evaluate`: Socratic. On attempt 1 a wrong or partial answer gets a guiding question or hint, never
  the answer; from attempt 2 the reply explains. At most 3 sentences. A `comment` only when the answer
  exposes a real defect in the PR, never because the reviewer was wrong.
- `draftComments`: concrete, kind, actionable comments for the PR author, grounded in the answers and
  notes; no repeats of existing drafts; none is a fine answer.
- `thread`: helps the reviewer phrase a better comment, pushes back when the comment is wrong, and
  proposes complete rewritten bodies only.

Each call costs the same budget cap (`filos.claude.maxBudgetUsd`) and timeout as a comprehension pass.

## Errors

Every failure is a `ProviderError` with a `kind` the UI can act on and the raw text in `detail`.

| kind | When |
|---|---|
| `notInstalled` | spawn fails with ENOENT/EACCES |
| `authExpired` | the result or stderr says: not logged in, `/login`, invalid API key, OAuth token expired / failed to refresh, "Failed to authenticate: OAuth session expired and could not be refreshed", `authentication_error`, 401, unauthorized; or `claude auth status` reports `loggedIn: false` |
| `budget` | result subtype mentions budget (`error_max_budget_usd`) |
| `contract` | `error_max_structured_output_retries`, no JSON in the answer, or `validateGraph` / the task validator's errors (joined in `detail`) |
| `timeout` | `timeoutSeconds` elapsed |
| `cancelled` | the request's `AbortSignal` fired |
| `failed` | anything else (rate limits, overload, crashes, forbidden tools), with the first line of the error as message |

The transient "Failed to refresh OAuth token: another Claude Code process is refreshing it…" error is
`authExpired` too; its `detail` says to retry in a minute, which the error view can show as is.

`checkReady()` runs `claude auth status` (fast, no API call) and throws `notInstalled` or
`authExpired`. `loginCommand` is `<claude path> auth login`, for display; `login` is the same as
`{command, args}`, which the host runs in a terminal directly (`shellPath`/`shellArgs`, cwd = home), so
no shell parses the path.

The host reads `filos.claude.path`, `filos.claude.model`, `filos.claude.maxBudgetUsd` and
`filos.agentTimeoutSeconds` from user settings only (`scope: machine`, read via `inspect().globalValue`):
a workspace's `.vscode/settings.json` arrives with the branch under review and must not choose the
binary or raise the limits. A relative `filos.claude.path` is refused.

## Testing

- `npm run test:unit` runs the provider against `test/fixtures/fake-claude` in every mode (see its
  README), the comprehension pass and every task. Point `filos.claude.path` (in user settings) at
  `test/fixtures/fake-claude/claude` for e2e.
- `npx tsx scripts/smoke-claude.ts --model sonnet --budget 0.5` runs one real pass over the fixture
  repo and prints cost, duration, tools offered and the validated graph (it writes the transcript to
  a temp dir). It costs real money: about $0.14 and 50 s with Sonnet on 2026-10-03.

## Adding Codex (or another CLI)

1. Write `src/agent/codexCli.ts` implementing `AgentProvider`. Reuse `runProcess` (`exec.ts`) for
   spawning, timeouts and cancellation, `buildPrompt` (`prompt.ts`) for the prompt, `toCliSchema`
   for the schema, and `validateGraph` + `repoReader` for validation. `ask()` only has to run
   `req.system` / `req.prompt` / `req.schema` with the requested tools and call `req.validate`: the
   task prompts and validators in `tasks.ts` are provider-neutral. Only the argv, the output parsing
   and the error patterns are CLI-specific.
2. Map Codex's equivalents: non-interactive exec mode, read-only sandbox, no approvals, JSON output
   against a schema file, and its own login check for `checkReady`.
3. Add `'codex'` to `ProviderConfig.id`, a case in `createProvider`, and the `filos.provider` enum.
4. Write a fake for it beside `test/fixtures/fake-claude` and run the same mode tests.

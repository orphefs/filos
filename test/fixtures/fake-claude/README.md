# fake-claude

A stand-in for the `claude` CLI, for unit and e2e tests. It parses the same print-mode flags as the
real CLI (strictly: an unknown flag fails, as it would for real) and prints the same shapes:
`--output-format stream-json` (one JSON message per line, ending with a `result` message), `json`
(only the `result` message) or `text`.

It answers two kinds of run. A system prompt (`--append-system-prompt`) whose first line is
`Filos task: <task>` is one of the small tasks (`questions`, `evaluate`, `draftComments`, `thread`);
anything else is the comprehension pass, which returns a review graph. `--tools=` (empty) gives the
run no tools, as for real: `init` then lists only `StructuredOutput`, and no Read/Grep calls appear.

## Use it

- **Executable:** `test/fixtures/fake-claude/claude` (a `#!/usr/bin/env node` wrapper, `chmod +x`).
  Point `filos.claude.path` at its **absolute** path, or pass it as `claudePath` to `createProvider`.
- **Repo:** `repo/` is a tiny head revision (`money/round.ts`, `checkout/total.ts`); `change.diff`
  is the PR diff against it, and `deps.txt` a dependency index for it.
- **Default graph:** `graph.json`, a valid review graph for `repo/` (hand-written).
- **Default question set:** `questions.json`, a valid set for `graph.json` (hand-written).
- **Real agent output:** `live-sonnet-graph.json`, what Claude Sonnet actually returned for `repo/` +
  `change.diff` + `deps.txt` in the live smoke test (2026-10-03). Replay it with
  `FAKE_CLAUDE_GRAPH=<abs path>/live-sonnet-graph.json` to see how the UI copes with real output.

## Environment

| Variable | Effect |
|---|---|
| `FAKE_CLAUDE_MODE` | Behaviour, see below. Default `ok`. |
| `FAKE_CLAUDE_MODE_<TASK>` | Mode for one task only, e.g. `FAKE_CLAUDE_MODE_EVALUATE=auth` (task name upper-cased: `QUESTIONS`, `EVALUATE`, `DRAFTCOMMENTS`, `THREAD`). Beats the two below. |
| `FAKE_CLAUDE_MODE_FILE` | A file holding the mode, read on every run (so a test can switch modes without touching the environment). Beats `FAKE_CLAUDE_MODE`; ignored when missing or empty. |
| `FAKE_CLAUDE_QUESTIONS` | Path to the question set the `questions` task returns. Without it: `questions.json` when the graph in the prompt has all its node ids, otherwise one multiple-choice predict question per changed module of that graph. The e2e suite can pass `fixtures/sample-questions.json`. |
| `FAKE_CLAUDE_EVALUATE` | Path to the JSON the `evaluate` task returns, instead of the built-in grading below. |
| `FAKE_CLAUDE_DRAFT_COMMENTS` | Path to the JSON the `draftComments` task returns. |
| `FAKE_CLAUDE_THREAD` | Path to the JSON the `thread` task returns. |
| `FAKE_CLAUDE_GRAPH` | Path to the graph returned in `ok`/`fenced`/`slow` modes, instead of `graph.json`. Use an absolute path (relative paths resolve against the CLI's cwd, i.e. the repo under review). The e2e suite uses `fixtures/sample-graph.json`. |
| `FAKE_CLAUDE_DELAY_MS` | How long `slow` (default 60000) and `badtools` (default 5000) wait. |
| `FAKE_CLAUDE_PIDFILE` | `slow` writes `{"cli": pid, "helper": pid}` here, so tests can check the process tree was killed. |
| `FAKE_CLAUDE_MESSAGE` | Overrides the error text in `auth` (result message) and `crash` (stderr). |
| `FAKE_CLAUDE_RECORD` | Writes `{argv, cwd, flags, task, tools, promptVia, prompt, schema, claudeEnv}` here: what the caller sent (`task` is `comprehend` for the comprehension pass). |

Paths are best given absolute (relative ones resolve against the CLI's cwd, the repo under review).
Every answer still goes through the provider's validators, so a supplied file must be valid too.

## What `ok` returns per task

| Task | Answer |
|---|---|
| comprehension | the graph (`graph.json` or `FAKE_CLAUDE_GRAPH`) |
| `questions` | see `FAKE_CLAUDE_QUESTIONS` above; a Read and a Grep call first |
| `evaluate` | an answer (the prompt's `ANSWER` block) containing `half-even`: `correct`. Otherwise `incorrect`, with a Socratic question on attempt 1 and an explanation from attempt 2 (read from "This is attempt N"). An answer mentioning `untested` or `no test` also carries a comment seed on `money/round.ts:10`. |
| `draftComments` | one `suggestion`, anchored to the first changed node with code in the prompt's graph (its id, file and first line) |
| `thread` | a reply and a complete `proposal` |

## Modes

Every mode applies to the comprehension pass and to every task alike.

| Mode | Print mode does | `auth status` | Provider should report |
|---|---|---|---|
| `ok` | init, a Read and a Grep tool call (when the run has those tools), then a successful result with `structured_output` = the answer | logged in, exit 0 | the answer |
| `fenced` | successful result with `structured_output: null`; the answer only as a ```` ```json ```` block in `result` | logged in | the answer (fallback parse) |
| `contract` | successful result with a broken answer: a graph with an edge to an unknown node and an anchor past the end of a file; a question about an unknown node; verdict `maybe`; `comments` not an array; a proposal without a reply | logged in | `contract` |
| `slow` | starts a helper process that shares stdout, waits `FAKE_CLAUDE_DELAY_MS`, then behaves like `ok` | logged in | `timeout` (short timeout) or `cancelled` (abort) |
| `auth` | `is_error: true`, `terminal_reason: "api_error"`, the real OAuth-refresh failure text; exit 1 | `{"loggedIn": false}`, exit 1 | `authExpired` |
| `budget` | `subtype: "error_max_budget_usd"`, `errors: ["Reached maximum budget ($cap)"]`; exit 1 | logged in | `budget` |
| `crash` | nothing on stdout, a stack trace on stderr, exit 3 | logged in | `failed` |
| `badtools` | init lists `Bash`, `Edit`, `Write` (a CLI that ignored `--tools`), then waits | logged in | `failed`, without waiting |

The prompt is read from a positional argument (after `--`) when present, otherwise from stdin; with
neither it fails like the real CLI. `--version` prints `0.0.0-fake (Claude Code)`.

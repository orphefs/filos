# fake-claude

A stand-in for the `claude` CLI, for unit and e2e tests. It parses the same print-mode flags as the
real CLI (strictly: an unknown flag fails, as it would for real) and prints the same shapes:
`--output-format stream-json` (one JSON message per line, ending with a `result` message), `json`
(only the `result` message) or `text`.

## Use it

- **Executable:** `test/fixtures/fake-claude/claude` (a `#!/usr/bin/env node` wrapper, `chmod +x`).
  Point `filos.claude.path` at its **absolute** path, or pass it as `claudePath` to `createProvider`.
- **Repo:** `repo/` is a tiny head revision (`money/round.ts`, `checkout/total.ts`); `change.diff`
  is the PR diff against it, and `deps.txt` a dependency index for it.
- **Default graph:** `graph.json`, a valid review graph for `repo/` (hand-written).
- **Real agent output:** `live-sonnet-graph.json`, what Claude Sonnet actually returned for `repo/` +
  `change.diff` + `deps.txt` in the live smoke test (2026-10-03). Replay it with
  `FAKE_CLAUDE_GRAPH=<abs path>/live-sonnet-graph.json` to see how the UI copes with real output.

## Environment

| Variable | Effect |
|---|---|
| `FAKE_CLAUDE_MODE` | Behaviour, see below. Default `ok`. |
| `FAKE_CLAUDE_GRAPH` | Path to the graph returned in `ok`/`fenced`/`slow` modes, instead of `graph.json`. Use an absolute path (relative paths resolve against the CLI's cwd, i.e. the repo under review). The e2e suite uses `fixtures/sample-graph.json`. |
| `FAKE_CLAUDE_DELAY_MS` | How long `slow` (default 60000) and `badtools` (default 5000) wait. |
| `FAKE_CLAUDE_PIDFILE` | `slow` writes `{"cli": pid, "helper": pid}` here, so tests can check the process tree was killed. |
| `FAKE_CLAUDE_MESSAGE` | Overrides the error text in `auth` (result message) and `crash` (stderr). |
| `FAKE_CLAUDE_RECORD` | Writes `{argv, cwd, flags, promptVia, prompt, schema, claudeEnv}` here: what the caller sent. |

## Modes

| Mode | Print mode does | `auth status` | Provider should report |
|---|---|---|---|
| `ok` | init, a Read and a Grep tool call, then a successful result with `structured_output` = the graph | logged in, exit 0 | the graph |
| `fenced` | successful result with `structured_output: null`; the graph only as a ```` ```json ```` block in `result` | logged in | the graph (fallback parse) |
| `contract` | successful result whose graph has an edge to an unknown node and an anchor past the end of a file | logged in | `contract` |
| `slow` | starts a helper process that shares stdout, waits `FAKE_CLAUDE_DELAY_MS`, then behaves like `ok` | logged in | `timeout` (short timeout) or `cancelled` (abort) |
| `auth` | `is_error: true`, `terminal_reason: "api_error"`, the real OAuth-refresh failure text; exit 1 | `{"loggedIn": false}`, exit 1 | `authExpired` |
| `budget` | `subtype: "error_max_budget_usd"`, `errors: ["Reached maximum budget ($cap)"]`; exit 1 | logged in | `budget` |
| `crash` | nothing on stdout, a stack trace on stderr, exit 3 | logged in | `failed` |
| `badtools` | init lists `Bash`, `Edit`, `Write` (a CLI that ignored `--tools`), then waits | logged in | `failed`, without waiting |

The prompt is read from a positional argument (after `--`) when present, otherwise from stdin; with
neither it fails like the real CLI. `--version` prints `0.0.0-fake (Claude Code)`.

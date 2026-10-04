# fake-codex

A stand-in for the OpenAI `codex` CLI, for unit and e2e tests. It parses the same `codex exec`
flags as codex-cli 0.160.0 (strictly, as clap does: an unknown flag, a missing value or an unknown
`--disable` feature name fails as it would for real) and prints the same `--json` event stream:

```
{"type":"thread.started","thread_id":"…"}
{"type":"turn.started"}
{"type":"item.completed","item":{"type":"agent_message","text":"I’ll read the touched file…"}}
{"type":"item.completed","item":{"type":"reasoning","text":"**Reading the change**…"}}
{"type":"item.started","item":{"type":"command_execution","command":"/bin/bash -lc 'nl -ba money/round.ts'",…}}
{"type":"item.completed","item":{"type":"command_execution",…,"exit_code":0,"status":"completed"}}
{"type":"item.completed","item":{"type":"agent_message","text":"{…the answer…}"}}
{"type":"turn.completed","usage":{"input_tokens":…,"cached_input_tokens":…,"output_tokens":…,"reasoning_output_tokens":…}}
```

The final message also goes to the `-o` file. The prompt is read from stdin (`-`).

It answers two kinds of run. A prompt whose **first line** is `Filos task: <task>` is one of the
small tasks (`questions`, `evaluate`, `draftComments`, `thread`); anything else is the
comprehension pass, which returns a review graph. A run has a shell (and so makes `nl`/`rg`
command items) unless both `--disable shell_tool` and `--disable unified_exec` are given, as for real.

**Config overrides.** Every `-c key=value` is parsed as TOML, as the real CLI does (strings,
inline tables, arrays, booleans, integers). Like codex-cli 0.160 it fails a `default_permissions` with
no `permissions.<name>.filesystem` table ("default_permissions requires a `[permissions]` table") and a
glob path (`*`, `?`, `[`, `]`) granted anything but `deny`; and a `--sandbox` beside a profile wins, as
for real (`effectiveSandbox` in the record says which applied).

**Skills.** Like the real CLI, a `$name` (or `[$label](skill://<path>)`) in the prompt pulls in a
SKILL.md found under the working root's `.agents/skills` or `.codex/skills` (6 levels deep, symlinks
followed; the name from its front matter) unless `-c skills.config=[{path=…, enabled=false}]` switches
it off. The record's `injectedSkills` lists what would have been injected.

**Strict schemas.** Like the API in strict mode, it rejects an `--output-schema` whose objects don't
list every property in `required` with `additionalProperties: false`, or that uses `$ref`, `const`,
`minLength`/`maxLength`, `oneOf` or `allOf`: the turn fails with an `invalid_json_schema` error. In
`ok`/`slow`/`badtools` it answers the way a strict-mode model does: every property present, `null`
where the canned answer has none. So the provider's `stripNulls` is exercised on every run.

## Use it

- **Executable:** `test/fixtures/fake-codex/codex` (a `#!/usr/bin/env node` wrapper, `chmod +x`).
  Point `filos.codex.path` at its **absolute** path, or pass it as `codexPath` to `createProvider`.
- **Repo, diff, graph, questions:** shared with fake-claude: `../fake-claude/repo/`,
  `../fake-claude/change.diff`, `../fake-claude/deps.txt`, `../fake-claude/graph.json`,
  `../fake-claude/questions.json`.

Other subcommands: `codex login status` (on stderr, as for real: "Logged in using ChatGPT", exit 0;
"Not logged in", exit 1 in `auth` mode; see `FAKE_CODEX_LOGIN`), `codex login`, `codex features list`
(a 0.160-like table), `codex mcp list --json` and `--version`.

## Environment

| Variable | Effect |
|---|---|
| `FAKE_CODEX_MODE` | Behaviour, see below. Default `ok`. |
| `FAKE_CODEX_MODE_<TASK>` | Mode for one task only, e.g. `FAKE_CODEX_MODE_EVALUATE=auth` (`QUESTIONS`, `EVALUATE`, `DRAFTCOMMENTS`, `THREAD`). Beats the two below. |
| `FAKE_CODEX_MODE_FILE` | A file holding the mode, read on every run. Beats `FAKE_CODEX_MODE`; ignored when missing or empty. |
| `FAKE_CODEX_GRAPH` | Path to the graph the comprehension pass returns, instead of `../fake-claude/graph.json`. Use an absolute path. |
| `FAKE_CODEX_QUESTIONS` | Path to the question set. Without it: `questions.json` when the prompt's graph has all its node ids, otherwise one predict question per changed module. |
| `FAKE_CODEX_EVALUATE`, `FAKE_CODEX_DRAFT_COMMENTS`, `FAKE_CODEX_THREAD` | Paths to the JSON those tasks return. |
| `FAKE_CODEX_DELAY_MS` | How long `slow` (default 60000) and `badtools` (default 5000) wait. |
| `FAKE_CODEX_PIDFILE` | `slow` writes `{"cli": pid, "helper": pid}` here, so tests can check the process tree was killed. |
| `FAKE_CODEX_MESSAGE` | Overrides the error text of `auth`, `model`, `quota` and `crash`. |
| `FAKE_CODEX_FEATURES` | Comma-separated feature names `features list` prints (and `--disable` accepts), instead of the built-in list. |
| `FAKE_CODEX_FEATURES_FAIL` | `config`: `features list` fails as 0.160 does on a malformed config.toml ("Error: failed to load bootstrap configuration … config.toml:2:8: unclosed table"). Any other value: it fails like a CLI without that subcommand. |
| `FAKE_CODEX_FEATURES_DELAY_MS` | `features list` waits this long first (for the listing's own timeout and cancel). |
| `FAKE_CODEX_LOGIN` | What `login status` answers: `ok` ("Logged in using ChatGPT"), `none` ("Not logged in", exit 1), `config` (0.160's "Error loading configuration: …config.toml:2:8: unclosed table…", exit 1), `weird` (an unknown text, exit 0). Default: `none` in `auth` mode, else `ok`. |
| `FAKE_CODEX_MCP_SERVERS` | JSON array of server names `mcp list --json` reports (default none). |
| `FAKE_CODEX_MCP_RECORD` | `mcp list` writes `{argv, cwd}` here. |
| `FAKE_CODEX_NO_LAST_MESSAGE` | Any value: don't write the `-o` file (the answer is only in the stream). |
| `FAKE_CODEX_RECORD` | `exec` writes `{argv, cwd, flags, configs, disabled, task, hasShell, promptVia, prompt, developerInstructions, permissions, effectiveSandbox, skillsDisabled, bundledSkills, injectedSkills, schema, agentEnv}` here (`task` is `comprehend` for the comprehension pass; `permissions` is `{profile, filesystem, network}` as parsed from the `-c` overrides; `agentEnv` lists the `CODEX*`/`CLAUDE*`/`OPENAI*`/`EXEC_WRAPPER` variables that reached it). |

Every answer still goes through the provider's validators, so a supplied file must be valid too.

## What `ok` returns per task

| Task | Answer |
|---|---|
| comprehension | the graph |
| `questions` | see `FAKE_CODEX_QUESTIONS`; commentary, an `nl -ba` and an `rg` command first |
| `evaluate` | an answer (the prompt's `ANSWER` block) containing `half-even`: `correct`. Otherwise `incorrect`, with a Socratic question on attempt 1 and an explanation from attempt 2. An answer mentioning `untested` or `no test` also carries a comment seed on `money/round.ts:10`. |
| `draftComments` | one `suggestion`, anchored to the first changed node with code in the prompt's graph |
| `thread` | a reply and a complete `proposal` |

## Modes

Every mode applies to the comprehension pass and to every task alike.

| Mode | `exec` does | `login status` | Provider should report |
|---|---|---|---|
| `ok` | commentary, reasoning and two commands (when the run has a shell), then the answer (nulls for absent fields) | logged in | the answer |
| `fenced` | the answer only as a ```` ```json ```` block in the final message | logged in | the answer (fallback parse) |
| `contract` | a broken answer: a graph with an edge to an unknown node; a question about an unknown node; verdict `maybe`; `comments` not an array; a null reply | logged in | `contract` |
| `empty` | the turn completes with no final message; `-o` is empty | logged in | `contract` |
| `slow` | starts a helper process that shares stdout, waits `FAKE_CODEX_DELAY_MS`, then behaves like `ok` | logged in | `timeout` (short timeout) or `cancelled` (abort) |
| `auth` | two "Reconnecting... n/2" errors, then a 401 `error` and `turn.failed`; a websocket 401 on stderr; exit 1 | "Not logged in", exit 1 | `authExpired` |
| `model` | an informational `error` item, then the **real** ChatGPT-account error (`{"type":"error","status":400,…"The 'gpt-5.3-codex' model is not supported when using Codex with a ChatGPT account."}`) as `error` and `turn.failed`; exit 1 | logged in | `failed`, saying to set `filos.codex.model` (or turn off `filos.codex.useUserConfig`) |
| `quota` | the ChatGPT usage-limit error ("You've hit your usage limit…"), exit 1 | logged in | `budget` |
| `crash` | a Rust panic on stderr, exit 101 | logged in | `failed` |
| `badtools` | a CLI that ignored the lockdown: a `file_change` item (or, with the shell off, a `command_execution`), then waits | logged in | `failed`, without waiting |

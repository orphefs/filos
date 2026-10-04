# Agent provider

The comprehension pass runs an agent CLI and turns its answer into a validated `ReviewGraph`.
Beside it, `ask()` runs the small structured tasks of the review (questions, grading, comment
drafting, threads; see "Small tasks" below). The host only sees `AgentProvider`
(`src/agent/provider.ts`); `createProvider` (`src/agent/index.ts`) picks the implementation from
`filos.provider`. There are two, and each runs every agent step:

- `ClaudeCliProvider` (`src/agent/claudeCli.ts`): the Claude Code CLI, `claude -p`.
- `CodexCliProvider` (`src/agent/codexCli.ts`): the OpenAI Codex CLI, `codex exec`. See "Codex" below.

We call the **CLI**, not an SDK, so the user's existing login (subscription, API key, ChatGPT
account, company SSO, Bedrock/Vertex settings) is inherited and Filos never touches credentials.

`ProviderConfig` is a union on `id`:

```ts
{ id: 'claude', claudePath, model?, maxBudgetUsd, timeoutSeconds, env?, promptVia?, onRawLine? }
{ id: 'codex',  codexPath,  model?, useUserConfig, timeoutSeconds, env?, onRawLine? }
```

Results carry `costUsd` when the CLI reports a cost (Claude Code) and `tokens`
(`{inputTokens, cachedInputTokens, outputTokens, reasoningOutputTokens}`) when it reports tokens
(Codex); `durationMs` always.

The sections up to "Testing" describe Claude Code; "Codex" covers what differs for Codex.

## How `claude` is invoked

`child_process.spawn` with an argument array (no shell), `cwd` = the repo with the head revision
checked out. A bare `claude` (or `codex`, `git`, `gh`) is looked up by Filos on the **absolute** PATH
entries and spawned by its absolute path, on every OS (`resolveCommand`): an empty or relative PATH
entry (`/usr/bin:/bin:`, `.`) resolves against the cwd, the repo under review, so a `claude` committed
there would run instead. Every child also gets PATH without such entries (`absolutePathEnv`), so the
`#!/usr/bin/env node` line of an npm-installed CLI can't find a `node` in the repo either. The PR prompt goes on **stdin**: there is no argv size limit, and the diff doesn't appear
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

## Codex

`CodexCliProvider` (`src/agent/codexCli.ts`, with `codexEvents.ts` and `codexSchema.ts`) runs
`codex exec` for the comprehension pass and for every task, with the same prompts, validators and
`ProviderError` kinds as Claude Code. Checked against codex-cli 0.160.0 on 2026-10-04, logged in with
a ChatGPT account.

### How `codex` is invoked

`child_process.spawn` with an argument array (no shell), through the same `runProcess` as Claude
Code (process-group kill on timeout or abort, output caps). `cwd` and `-C` are the repository's real
path. The executable is the codex binary itself, found by `locateCodex` (`codexInstall.ts`): a name
is looked up on absolute PATH entries only, and an npm launcher (`bin/codex.js`, or `codex.cmd` /
`codex.ps1` on Windows, which spawn can't start without a shell) is followed to the binary it starts,
`…/@openai/codex-<os>-<arch>/vendor/<triple>/bin/codex[.exe]`, found the way the launcher finds it.
Every run, in both config modes:

```
codex exec
  --json                                   JSONL events on stdout (progress, usage, errors)
  --ephemeral                              no session files in ~/.codex
  --skip-git-repo-check                    a PR checkout may not look like a repo Codex knows
  --ignore-rules                           no execpolicy .rules files (the user's or the repo's)
  [--ignore-user-config]                   unless filos.codex.useUserConfig, see below
  -C <repo> --output-schema <tmp>/output-schema.json -o <tmp>/last-message.txt
  -c approval_policy="never"               exec can't answer prompts; anything needing approval is refused
  -c project_doc_max_bytes=0               the repo's AGENTS.md is PR content: it must not become instructions
  -c web_search="disabled"                 no web search tool
  -c skills.include_instructions=false     no skill list in the prompt (the repo's .codex/skills and
                                           .agents/skills are PR content too)
  -c skills.bundled.enabled=false          Codex's own skills (skill-installer, imagegen…) off
  -c shell_environment_policy.inherit="core"  commands see PATH, HOME and the like, not every variable
                                           of the editor's environment
  -c default_permissions="filos_<random>"  Filos's permission profile instead of a sandbox mode, see
  -c permissions.filos_<random>.filesystem={":minimal"="read", "<repo>"="read", "<codex files>"="read"}
  -c permissions.filos_<random>.network={enabled=false}       "Sandbox" below
  [-c skills.config=[{path="…/SKILL.md", enabled=false}, …]]  every skill Codex would find, off
  [-c mcp_servers={"<name>"={enabled=false}, …}]   useUserConfig only, see below
  -c developer_instructions="<the task's rules>"   see "Prompt"
  --disable <feature> …                    see below
  [-m <filos.codex.model>]
  -                                        the prompt comes on stdin
```

Never passed: `--dangerously-bypass-approvals-and-sandbox`, `--dangerously-bypass-hook-trust`,
`--add-dir`, `--worktree`, `--approve-for-me`, `--enable`, and `--sandbox` / `--profile`: with
`--sandbox`, the sandbox mode wins over `default_permissions` (checked), so the profile would be
ignored (tests check all of these).

### Sandbox

Codex's built-in `read-only` sandbox (and the `:read-only` profile) lets commands read **every file
the user can**: `cat ~/.codex/auth.json`, `~/.ssh/…`, `~/.config/gh/hosts.yml`, the other pull request
checkouts in Filos's storage, or the target of a symlink the branch adds. A diff can ask the agent to
do exactly that and quote the result in the graph, which then reaches OpenAI and, through
`nodeSummary`, the drafting prompts. So every run uses Filos's own permission profile
(`sandboxConfig`), defined through `-c` and named by `-c default_permissions`:

- `":minimal"="read"`: the platform paths a shell needs (/bin, /usr, /etc, a private /tmp and /proc).
- the repository, by its real path, `"read"`.
- Codex's own files, `"read"`: its Linux sandbox helper re-runs the codex binary inside the sandbox
  (without it every command fails with `bwrap: execvp …/codex: No such file or directory`), and its
  bundled `rg` lives beside it. For an npm install that is the `vendor/<triple>` folder, else the
  binary alone (`locateCodex`'s `readable`).
- nothing writable; `network={enabled=false}`.

The profile's name is new per run (`filos_<12 hex>`): a `[permissions.<name>]` table in a loaded
config.toml merges into an override of the same name (checked: a user config's extra entry widened a
fixed-name profile), so a fixed name could be widened from config. A path Codex would read as a glob
(`*`, `?`, `[`, `]`) can only be denied, never granted, so a repository under such a path is refused
before the run ("Filos can't confine Codex to this repository").

Checked with codex-cli 0.160.0 on Linux (bubblewrap), with Filos's full argv against a local
stand-in for the Responses API (no OpenAI call), including a user config that sets
`sandbox_mode = "danger-full-access"`: a file outside the repo, a symlink out of the repo and
`~/.codex/auth.json` all read as "No such file or directory"; `nl -ba`, `rg` and `cat` in the repo
work; `touch` fails ("Read-only file system"); a socket fails ("Operation not permitted"); `/proc`
shows only the sandbox's own processes. macOS (Seatbelt) and Windows were not checked.

### Skills

Hiding the skill list (`skills.include_instructions=false`) is not enough: Codex still resolves an
explicit `$name` mention, or `[$label](skill://<path>)`, anywhere in the user message (the diff and the
PR text are in it) and injects that SKILL.md as if the user had asked for it (checked: a repo skill
named `style` was injected for `$style`, `x$style`, `` `$style` `` and `[$x](skill:///…/SKILL.md)`). So:

- `skillFiles` lists every SKILL.md Codex could load: the repository's `.agents/skills` and
  `.codex/skills` from the project root down to the repo, `CODEX_HOME/skills`, `~/.agents/skills` and
  `/etc/codex/skills`, 12 levels deep (Codex itself looks 6), following symlinked folders as Codex
  does. One `-c skills.config=[{path=…, enabled=false}, …]` switches each off (checked: a SKILL.md path
  works, a folder path doesn't; the symlinked and the real path both work). More than 150 is refused.
- `skills.bundled.enabled=false` switches Codex's own skills off (checked).
- Backstop: on stdin, every `$` that starts a name gets a word joiner (U+2060) after it
  (`breakSkillMentions`; checked: `$\u2060style` is no mention). `restoreSkillMentions` takes it out of
  the answer again, so a reply quoting `$HOME` reads `$HOME`.

**Features.** `--disable` for every risky feature that is on by default or that a user config could
turn on: `apps`, `enable_mcp_apps`, `plugins`, `remote_plugin`, `plugin_sharing`,
`recommended_plugins`, `browser_use*`, `computer_use*`, `in_app_*`, `hooks`, `image_generation`,
`multi_agent`, `multi_agent_v2`, `skill_mcp_dependency_install`, `skill_search`, `goals`,
`tool_suggest`, `workspace_dependencies`, `worktrees`, `realtime_conversation`, `memories`,
`code_mode`, `standalone_web_search`, `request_permissions_tool`. An unknown name is an error
("Unknown feature flag"), so the provider runs `codex features list` once per provider instance
and passes only names the installed CLI knows (removed ones are skipped). If the listing fails,
the run fails ("Couldn't list Codex's features"): it never runs with less lockdown.

`view_image` is off for every run: Codex runs it itself, outside the sandbox, so it could open an image
anywhere on disk.

**Tasks without tools** (`evaluate`, `draftComments`, `thread`) also get `--disable shell_tool
--disable unified_exec`. The comprehension pass and `questions` keep the shell: Codex has no
Read/Grep/Glob, it reads with commands (`nl -ba`, `rg`) inside the permission profile.

**How the lockdown was checked.** Pointing Codex at a local stand-in for the Responses API
(`-c model_provider=…` with a `base_url` on 127.0.0.1, no credentials) shows exactly what it would
send. With a probe repo holding an `AGENTS.md`, `.codex/skills/…`, `.agents/skills/…` and a
`.codex/config.toml` (developer instructions and an MCP server whose command touches a marker file):

- Plain `codex exec`: tools `exec_command, write_stdin, list_mcp_resources, …, apply_patch,
  view_image, get_goal, create_goal, update_goal, tool_search, web_search`; AGENTS.md and both
  skill folders in the prompt; with a user config that trusts the folder, the repo's
  developer instructions too, and both MCP servers started.
- Filos's flags, read tools: `exec_command, write_stdin, request_user_input, apply_patch,
  view_image`; no AGENTS.md, no skills, no MCP. No tools: `request_user_input, apply_patch` only.
  `text.format` is `{"type":"json_schema","strict":true,…}`.
- `apply_patch` comes from the model catalogue, not a setting; the permission profile has nothing
  writable, so any patch is refused. `request_user_input` answers "not supported in exec mode".

### Config modes and MCP

- **Default (`filos.codex.useUserConfig` off):** `--ignore-user-config`. Codex runs with its defaults
  and the login in `CODEX_HOME` (auth still works). The user's `~/.codex/config.toml` doesn't apply,
  so neither its model (a `model = "gpt-5.3-codex"` there fails with a ChatGPT account) nor its MCP
  servers. The repo's own `.codex/config.toml` isn't loaded either: Codex loads project config only
  for folders the user config trusts, and there is no user config (checked: no developer
  instructions from it, its MCP server never started).
- **`useUserConfig` on** (for a company model provider or SSO that lives in config.toml): every flag
  above still applies, and two more steps run first:
  1. **Repo config refused.** If `.codex/config.toml` exists in the repo (from the project root, the
     nearest folder with `.git`, down to the repo), the run fails with a message saying to turn the
     setting off. Codex would load it for a trusted folder, it comes with the change under review,
     and a `-c projects."<path>".trust_level="untrusted"` override does not stop it (checked).
  2. **MCP off.** `codex mcp list --json` (cwd = the repo, so it lists what Codex would load) names
     every configured server, and one `-c mcp_servers={"a"={enabled=false}, …}` turns each off.
     `-c mcp_servers={}` does **not** work: overrides merge into the loaded table and the servers
     survive (checked with `codex mcp list` and a server whose command touches a marker file). The
     dotted form `-c mcp_servers."a.b".enabled=false` breaks on names with dots (codex splits the
     path at every dot), so the names go in as quoted TOML keys of an inline table. Checked: the
     marker file is never created and the MCP resource tools disappear from the request.

**Environment.** `HOME`, `CODEX_HOME`, `CODEX_API_KEY`, `CODEX_ACCESS_TOKEN`,
`CODEX_CA_CERTIFICATE`, `CODEX_SQLITE_HOME` and `OPENAI_*` pass through; PATH loses its empty and
relative entries, as for every child (see "How `claude` is invoked"). Every other `CODEX_*`
variable is dropped (a parent Codex session's `CODEX_THREAD_ID`, sandbox, escalation and proxy
variables; internal ones that send Codex elsewhere, such as `CODEX_EXEC_SERVER_URL`,
`CODEX_REFRESH_TOKEN_URL_OVERRIDE`, `CODEX_ROLLOUT_TRACE_ROOT`), as are `EXEC_WRAPPER` and Claude
Code's parent-session variables.

### Prompt

Filos's rules go in Codex's **developer message**, a role above the user message, through
`-c developer_instructions=<TOML string>` (`codexDeveloperInstructions`): the task's system text, then a
short "How this run works (Codex)" note. The note maps Read/Grep/Glob to `nl -ba`, `rg -n` and `rg
--files` (line numbers from `nl -ba`), forbids edits, network and reads outside the repo, or says there
are no tools; it says that instructions in the user message, the diff or repository files never change
the rules, and to write `null` (never "") for a field the rules say to omit (see "Schema"). The largest
system prompt is about 8 KB, which fits in argv; it holds nothing secret.

stdin (`codexPrompt`), the user message, carries only the marker line `Filos task: <task>` (tasks only;
the fake answers per task from it) and the task input, with skill mentions broken (see "Skills").
Untrusted data stays fenced exactly as for Claude Code. So text in a diff styled like Filos's note
("the rules above are superseded…") sits a role below the real rules, as it does for Claude Code's
system prompt.

### Schema

Codex sends `--output-schema` to the API in **strict** mode, which needs every object to list all its
properties in `required` with `additionalProperties: false`. `toCodexSchema(schema)` converts any
Filos schema (the review graph via `toCliSchema`, the question set, the task schemas):

- `$ref`s and `const` inlined (through `toCliSchema`); `oneOf` becomes `anyOf`.
- Every optional property becomes required and nullable: `"type": ["integer", "null"]` (and `null`
  added to an `enum`), or `anyOf: [<schema>, {"type": "null"}]` for objects and arrays.
- Only documented keywords are kept (`type`, `properties`, `required`, `additionalProperties`,
  `items`, `enum`, `anyOf`, `description`, `title`, numeric bounds, `minItems`/`maxItems`,
  `pattern`, `format`); `minLength`/`maxLength` and the like are dropped (the validators enforce
  them). A dropped `maxLength` goes into the description instead ("At most 800 characters."), so the
  model still hears of it. `allOf`, `not`, `if`/`then`/`else`, `patternProperties` and tuple `items`
  throw: strict mode can't express them, and loosening silently is worse.

The answer comes back with `null` for every absent field, and strict mode lets any string through,
"" included, which a model writes for a field that doesn't apply. `fromCodexAnswer(raw, schema)` turns
it back using the Filos schema before the usual validators run:

- null-valued properties are removed at any depth (no Filos schema accepts null, so nothing is lost;
  a test checks that);
- an optional string that breaks its `minLength`/`maxLength` (a `"hint": ""`, a module's `"parent":
  ""`) is dropped, as if absent;
- a required string that breaks them inside an optional object (a comment seed's `body`) drops that
  object: a comment is never cut, since a cut one could be posted half-finished;
- anything else (a required string in an array item or at the root) is left to the validators.

Each drop is a `repaired: …` warning in the result. Then the same validators as for Claude Code, in
repair mode where it uses them: `validateGraph` (repair, repo-confined reader), `checkQuestions`,
`validateEvaluate`, `validateDraftComments`, `validateThreadReply`. In repair mode (both CLIs) two
repairs keep one stray field from costing the whole answer: `validateQuestionSet` drops a question
the schema errors point into (an `explain` of 801 characters) rather than failing the set, and
`validateGraph` cuts over-long display text (orientation, labels, gists, symbols) at a word with "…".

The answer is the `-o` file; if that file is missing, the last `agent_message` of the stream. An
empty file is an empty answer (`contract`), never the commentary Codex wrote before its commands.

Live check (2026-10-04, Codex's default model, `--ignore-user-config`): the converted review-graph
schema was accepted, and the graph passed `validateGraph` with no repairs.

### Progress and usage

From the JSONL events, through `safeProgressText`, with paths shown only inside the repo:
`command_execution` → "Reading money/round.ts" when the command clearly reads a file (`cat`,
`nl`, `head`, `tail`, `sed -n`, …), "Searching for “pattern”" for `rg`/`grep`/`git grep`, "Listing
files" for `ls`/`find`/`rg --files`, else "Running a read-only command"; when it completes, the
thinking text again ("Thinking about how the pieces fit…"), which covers the quiet stretch before the
answer. `reasoning` → the thinking text. `agent_message` → "Writing the review graph…" (or the
task's wording) only when it is the JSON answer; Codex also sends a line of commentary first ("I’ll
read the touched file…"), which shows as thinking. "Reconnecting... 2/5" errors → "Reconnecting to
Codex 2/5…".

Tokens come from `turn.completed.usage` (`input_tokens`, `cached_input_tokens`, `output_tokens`,
`reasoning_output_tokens`) into the result's `tokens`. Codex reports **no cost**: `costUsd` is
undefined, and there is no budget cap.

Defence in depth: an item of type `file_change`, `mcp_tool_call`, `web_search`, `collab_tool_call`
(and the like) stops the run at once (`failed`: "Codex used a tool Filos never allows"), as does a
`command_execution` in a run that asked for no tools.

### Errors

| kind | Codex |
|---|---|
| `notInstalled` | spawn fails with ENOENT/EACCES ("Install it (npm install -g @openai/codex), or set filos.codex.path") |
| `authExpired` | not logged in, 401 / unauthorized / missing bearer, token expired or not refreshed, "codex login", sign in again; `codex login status` answering "Not logged in" when no other login can apply (below) |
| `budget` | 429, "usage limit", rate limit, quota: "Codex hit a usage or rate limit of your account (not a Filos cap): …" |
| `contract` | no final message, a non-JSON answer, or validation errors (in `detail`) |
| `timeout` / `cancelled` | as for Claude Code |
| `failed` | an unsupported or unknown model (below), a rejected output schema, a forbidden tool, a crash, a repo with its own `.codex/config.toml` in useUserConfig mode, a repo path Codex reads as a glob, more than 150 skills, a listing before the run (features, MCP servers) that doesn't answer within 30 s ("Couldn't list Codex's features within 30 s", not the run's timeout), a config.toml Codex can't load, anything else |

An **unsupported model** stays `failed` with a message that says how to fix it. The real text with a
ChatGPT account (live smoke, 2026-10-04):

```
{"type":"error","message":"{\"type\":\"error\",\"status\":400,\"error\":{\"type\":\"invalid_request_error\",\"message\":\"The 'gpt-5.3-codex' model is not supported when using Codex with a ChatGPT account.\"}}"}
{"type":"turn.failed","error":{"message":"…the same…"}}                                  exit 1
```

becomes "Codex can't use the model "gpt-5.3-codex" with your account: The 'gpt-5.3-codex' model is
not supported when using Codex with a ChatGPT account. To fix it, set filos.codex.model to a model
your account supports, or leave it empty for Codex’s default." With useUserConfig on (the model came
from config.toml), it adds "or turn off filos.codex.useUserConfig so the model in
~/.codex/config.toml is ignored."

Codex retries a failing request itself (up to five "Reconnecting... n/5" errors over websocket, then
again over HTTPS, seen with a 401) before `turn.failed`; only the final error is classified, and the
retries show as "Reconnecting to Codex n/5…".

`checkReady()` runs `codex login status` (it prints on stderr: "Logged in using ChatGPT", exit 0;
"Not logged in", exit 1). That command looks at the stored login only: with `CODEX_API_KEY` set, or a
company model provider in config.toml (`env_key`, `requires_openai_auth = false`), it still says "Not
logged in" (checked with an empty CODEX_HOME), and a malformed config.toml makes it print "Error
loading configuration: …/config.toml:2:8: unclosed table…", exit 1, even though `exec
--ignore-user-config` works. So only "Not logged in" with no `CODEX_API_KEY`, `CODEX_ACCESS_TOKEN` or
`OPENAI_API_KEY` and `filos.codex.useUserConfig` off is `authExpired`; anything else that isn't
"Logged in" is `failed`, which the callers treat as inconclusive (the run itself then classifies a
real 401 as `authExpired`), and the agent picker shows as "Couldn't check: …", not "not logged in".
`codex features list` reads config.toml too (it has no `--ignore-user-config`); when that fails on the
file, the error says so ("Codex couldn't load its configuration … Fix ~/.codex/config.toml") rather
than "Update Codex".

The listings before a run (`features list`, shared by concurrent runs; `mcp list`) have their own
30 s limit, reported as such. A cancel stops the caller's wait at once; the shared listing keeps going
for the other callers.

`loginCommand` is `<codex path> login`; `login` is `{command: <codex path>, args: ['login']}`, except
on Windows, where it is the codex.exe behind an npm launcher (a terminal can't run a `.cmd` without a
shell).

**Not installed.** The `notInstalled` message says to `npm install -g @openai/codex` or set
`filos.codex.path`; on Windows it adds that Filos starts the `codex.exe` the npm launcher would, and
where npm puts it, in case Filos can't find it.

### Settings

`filos.provider: "codex"`, `filos.codex.path` (default `codex`), `filos.codex.model` (empty: Codex's
default), `filos.codex.useUserConfig` (default off), and the shared `filos.agentTimeoutSeconds`. All
user-level only, like the Claude settings. `filos.claude.maxBudgetUsd` doesn't apply.

### Limits

- **No dollar cap.** Codex reports tokens, not cost, and has no budget flag. A ChatGPT plan's usage
  limits apply (reported as `budget`); `filos.agentTimeoutSeconds` is the only bound Filos sets.
- **Reads are confined by the permission profile on Linux** (see "Sandbox"): the repo, the
  platform's minimal paths and Codex's own files. Commands still run: a script the PR ships can be
  run, but only with those reads, no writes and no network. macOS and Windows were not checked:
  Filos passes the same profile there and never `--sandbox`, so how much of it is enforced is up to
  Codex's sandbox on those systems (Seatbelt; Windows' restricted token).
- `generatedBy.model` is the configured model, or absent: `codex exec --json` doesn't report which
  model answered.
- Only one tool exists to read with (the shell), so the comprehension pass reads through commands;
  the live pass made 2 commands (`nl -ba … && rg -n …`, `rg --files`).

### Testing

- `npm run test:unit` runs `test/unit/codex*.test.ts`: argv (lockdown in every mode, the permission
  profile, skills off, the developer message, no dangerous flag, user-config mode, model, no-tools),
  `locateCodex` (npm layouts, Windows launchers), schema conversion (strict-mode invariants over every
  Filos schema, `stripNulls` / `fromCodexAnswer` round trips the validators accept, length repairs),
  event → progress, error classification (including the real model error), and the provider against
  `test/fixtures/fake-codex` in every mode (see its README), including a repo that ships a skill and
  mentions it, a `codex` and a `node` committed to the repo with relative PATH entries, the login
  check's inconclusive answers, and a slow or cancelled features listing.
- `npx tsx scripts/smoke-codex.ts` runs one real comprehension pass over the fixture repo, then one
  `evaluateAnswer` and one `threadReply`, with the default config mode and model, and prints
  durations, tokens, commands, warnings and the replies. `--expect-model-error <model>` adds one
  tiny call that shows how an unsupported model is reported. On 2026-10-04 (ChatGPT account, default
  model): comprehension 44.0 s, 34,672 input tokens (22,016 cached), 1,805 output (378 reasoning),
  valid graph, no repairs; evaluate 4.5 s; thread 5.7 s; no commands in either.

## Adding another CLI

1. Write `src/agent/<name>Cli.ts` implementing `AgentProvider`. Reuse `runProcess` and `scrubEnv`
   (`exec.ts`) for spawning, timeouts, cancellation and the environment, `buildPrompt` (`prompt.ts`)
   for the prompt, `toCliSchema` (or `toCodexSchema` for a strict-mode backend) for the schema, and
   `validateGraph` + `repoReader` for validation. `ask()` only has to run `req.system` /
   `req.prompt` / `req.schema` with the requested tools and call `req.validate`.
2. Add a variant to `ProviderConfig`, a case in `createProvider`, and the `filos.provider` enum.
3. Write a fake beside `test/fixtures/fake-claude` and `fake-codex` and run the same mode tests.

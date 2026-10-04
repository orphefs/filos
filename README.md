# Filos

*Filos* (Greek: friend) is Socratic PR review for VS Code. It leaves you understanding the code, not just the diff.

**Prototype.** This build covers build-order slices 1–4 and 6 from [CLAUDE.md](CLAUDE.md):

- a graph of the PR's main changes, with risk tinting computed from countable signals,
- click a node to open the relevant code beside the graph, with unrelated regions folded down to one-line gists,
- a comprehension pass run by your agent CLI (Claude Code or Codex), validated against the [review-graph contract](docs/graph-contract.md),
- questions about the change, draft comments you accept, reject, amend or discuss with the agent, and posting to the PR through `gh` ([question-set contract](docs/questions-contract.md)),
- a whole GitHub pull request, from pointing Filos at it to posting the review, with every agent step run by the agent CLI you choose,
- didactic mode: territories in fog until you answer your way in, with progress as coverage.

Slices 4 and 6 were built autonomously: their UX is provisional ([review-and-didactic.md](docs/review-and-didactic.md)).

## Commands

| Command | What it does |
| --- | --- |
| **Filos: Review Pull Request…** | Reviews a GitHub pull request: pick one of the workspace repository's open pull requests, or enter its URL, `owner/repo#123` or a number. The code goes into Filos's own storage, never your workspace. |
| **Filos: Review Current Branch** | Runs the agent on your workspace's branch compared with its base. |
| **Filos: Review Current Branch Against…** | The same, against a base branch you choose. |
| **Filos: Review Sample PR (bundled example)** | Opens the bundled sample PR with a hand-written graph. No agent and no cost. |
| **Filos: Review Sample PR with Agent** | Runs the agent on the same sample PR. |
| **Filos: Delete Pull Request Checkouts** | Deletes the clones Filos keeps for pull request reviews, after showing how much space they take. |
| **Filos: Choose Agent CLI…** | Picks the agent CLI every agent step runs on: Claude Code or Codex. Shows whether each is installed and logged in. |

The sample also opens from a link: `vscode://orphefs.filos/reviewSample`.

The agent runs through your installed CLI (`claude` or `codex`) and GitHub through `gh`, each with your existing login. Filos never handles credentials.

## Choosing the agent

Filos runs one agent CLI for every agent step: the comprehension graph, the questions, grading your answers, drafting comments and the comment threads. Two are supported:

- **Claude Code** (`claude`), the default. It uses your Claude login: a subscription, an API key, or Bedrock/Vertex settings.
- **Codex** (`codex`, the OpenAI Codex CLI). It uses your Codex login: a ChatGPT account or an API key.

Run **Filos: Choose Agent CLI…**, or click **Agent: … Change…** in the review header. The list shows, for each CLI, whether Filos found it and whether you are logged in. If you aren't, Filos offers to open the CLI's own login in a terminal. The choice is saved in your user settings as `filos.provider`, and the next agent step uses it, including in a review that is already open. If Filos can't find the agent CLI, the error view offers **Choose agent…** too.

Whichever CLI runs, Filos locks it down to reading: it may read the repository under review but not change it, and its answers are checked against Filos's contracts before anything is shown. See [docs/agent-provider.md](docs/agent-provider.md) for exactly how each CLI is invoked.

### Settings

All of these are read from your user settings only. A repository's `.vscode/settings.json` arrives with the branch under review, so it can't choose which program Filos runs or raise its limits.

| Setting | Default | What it does |
| --- | --- | --- |
| `filos.provider` | `claude` | The agent CLI: `claude` (Claude Code) or `codex` (Codex). |
| `filos.claude.path` | `claude` | The `claude` executable: a name on PATH, an absolute path, or `~/…`. |
| `filos.claude.model` | `sonnet` | Claude Code model alias. Empty uses the CLI's default. |
| `filos.claude.maxBudgetUsd` | `1` | Spending cap in US dollars per Claude Code call. Claude Code only. |
| `filos.codex.path` | `codex` | The `codex` executable: a name on PATH, an absolute path, or `~/…`. An npm install's launcher (`codex.cmd` on Windows) is followed to the `codex.exe` it starts; if Filos can't find it, point this at that `codex.exe`. |
| `filos.codex.model` | empty | Codex model. Empty uses Codex's default. A ChatGPT account can't use every model: one it doesn't support fails with "not supported when using Codex with a ChatGPT account". |
| `filos.codex.useUserConfig` | `false` | Load `~/.codex/config.toml`, e.g. for a custom model provider such as company SSO. Filos's read-only lockdown still applies. Off, Codex runs with its login and its defaults only. |
| `filos.agentTimeoutSeconds` | `600` | Stops the agent CLI after this many seconds (at most 3600). Codex reports no dollar cost, so for Codex this is the bound. |
| `filos.gh.path` | `gh` | The GitHub CLI. |

## The flow

1. **Point Filos at a pull request.** Run **Filos: Review Pull Request…** and pick it, or paste its URL.
2. **Watch the steps.** The panel opens at once with a checklist:
   - *Find the pull request*: `gh pr view`, e.g. "#9 · 14 files · +440 −176".
   - *Get the code*: a blobless clone of the repository in Filos's storage (made once, then only fetched), with the pull request's head checked out in a worktree of its own. Hooks never run there. A closed or merged pull request is compared with its base as it was, as GitHub shows it.
   - *Claude Code reads the change* (or *Codex reads the change*): the comprehension pass, with its live progress.
   - *Claude Code writes questions*: this one carries on in the side pane once the graph is up.
   If a step fails, it is marked, with what to do (Retry, or Log in again for gh or the agent CLI). Cancel stops it.
3. **Explore the graph.** Click a node to open its code beside the graph, folded down to what matters. A pull request's files open read-only, through Filos's own `filos-pr:` file system: no other extension takes the checkout for a project of yours and runs code from it (a linter loading the pull request's `node_modules`, say).
4. **Answer the questions**, in fast mode or in didactic mode (territories in fog until you answer your way in). The agent grades open answers.
5. **Shape the comments.** Accept, reject or amend each draft, or open a thread with the agent about it; add your own notes.
6. **Confirm and post.** Filos shows where the review goes and what it says, and posts it through `gh` only when you confirm. A merged or closed pull request can still be reviewed to learn the code; it is not posted to.

**Re-run analysis** fetches the pull request again and keeps your answers and comments. They are kept per pull request, whichever VS Code window you open it from. Several windows can review pull requests at once: each waits for the others when they work on the same clone, and none deletes a checkout another one is showing.

## Develop

```bash
npm install
npm run build        # dist/extension.js, dist/webview.js
npm run test:unit    # contract, risk, provider (fake CLI), review model
npm run test:e2e     # real VS Code, headless under xvfb, with fake agent and gh CLIs
npm run validate:fixture     # the sample graph against the graph contract
npm run validate:questions   # the sample questions against the question-set contract
npm run harness      # webview alone in a browser, mocked host
npm run package      # dist/filos.vsix
```

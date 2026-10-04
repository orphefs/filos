# Filos

*Filos* (Greek φίλος, friend) is Socratic pull-request review for VS Code. It shows you what a change does and asks you about it, so that you understand the code you approve rather than skimming the diff.

> **Preview.** Filos is an early prototype. Its screens and wording will change, and agent answers vary from run to run. Feedback is welcome in the [issues](https://github.com/orphefs/filos/issues).

![The graph of a pull request beside its code, with the risky function highlighted](media/screenshots/graph-and-code.png)

## Install

Filos isn't on the VS Code Marketplace yet. You install it from a file:

1. Download `filos-0.1.0.vsix` from the [Releases page](https://github.com/orphefs/filos/releases).
2. In VS Code, open the Command Palette, run **Extensions: Install from VSIX…** and pick the file.

   Or, in a terminal: `code --install-extension filos-0.1.0.vsix`. On macOS, run **Shell Command: Install 'code' command in PATH** in VS Code once first, so that `code` exists.

You also need:

- VS Code 1.100 or later, on Linux or macOS. Windows is untested.
- An agent CLI, installed and logged in: [Claude Code](https://docs.anthropic.com/en/docs/claude-code) (`claude`) or the [Codex CLI](https://github.com/openai/codex) (`codex`).
- For pull requests and posting: the [GitHub CLI](https://cli.github.com) (`gh`), logged in with `gh auth login`, and `git`. On macOS, `git` comes with Apple's Command Line Tools: run `xcode-select --install` if you don't have them.

**On macOS,** if Filos says it can't find `claude`, `codex` or `gh`, VS Code may not have your terminal's PATH. This can happen when VS Code is started from the Dock and the CLI lives in Homebrew's folder or `~/.local/bin`. When the CLI is in one of the usual install folders, Filos's message names its path. Otherwise, run `which claude` (or `codex`, or `gh`) in Terminal. Then put the full path in your **user** settings: `filos.claude.path`, `filos.codex.path` or `filos.gh.path`. For example, `/opt/homebrew/bin/gh` or `~/.local/bin/claude`.

## How it works

1. **Point Filos at a pull request.** Run **Filos: Review Pull Request…**, then pick one of the workspace repository's open pull requests or paste a URL. Filos clones the code into its own storage, never into your workspace.
2. **Read the map.** Your agent CLI (Claude Code or Codex) reads the change. Filos draws it as a graph of modules and functions, tinted redder where the risk is higher. The risk colour is computed from countable signals: consumers outside the repo, in-repo callers, public API, missing tests, behaviour changes.
3. **Open only what matters.** Click a node to open its code beside the graph. Everything unrelated stays folded, with a one-line gist of what it does.
4. **Answer questions.** Filos asks about the change before and after you read the code. A wrong answer gets a hint, not the answer.
5. **Turn your answers into comments.** Your judgements draft review comments. Accept, reject or amend each one, or discuss it with the agent.
6. **Confirm and post.** Filos shows where the review goes and how many comments it holds, and posts through the GitHub CLI only when you confirm.

## Fast or didactic

**Fast** gives you the graph, the questions and the comments, so you can get through a pull request quickly.

**Didactic** turns the change into a map in fog. To enter a module, you first say whether you know it, then predict what the change does. Only then does the code open. Progress is how much of the map you've explored, not points.

![Didactic mode: modules in fog, and the question that opens one](media/screenshots/didactic.png)

![A question with a Socratic hint after a wrong answer](media/screenshots/questions.png)

![A drafted comment, with Accept, Reject, Amend and Discuss](media/screenshots/comments.png)

## Trying it out

A good first session:

1. **The sample.** Run **Filos: Review Sample PR (bundled example)**. It opens a hand-written review of a small pull request: no agent, no cost. Click around the graph, answer a few questions, and switch between **Fast** and **Didactic** at the top.
2. **Your agent.** Run **Filos: Choose Agent CLI…** to pick Claude Code or Codex. It shows whether each is installed and logged in.
3. **One real pull request of your own.** Run **Filos: Review Pull Request…** on one you would review anyway, ideally in code you know. Try Fast, Didactic, or both.
4. **One comment thread.** On a drafted comment, click **Discuss** and push back on it.

You don't have to post anything. Filos posts only after you confirm, and **Export as Markdown** copies the review instead.

On a 14-file pull request, getting the graph and the questions ready took about 10 minutes with Claude Code and cost about $1.50. With Codex it took about 5 minutes. You can explore the graph while the questions are being written. See [Cost and time](#cost-and-time).

**Please tell me how it went.** [Open a Feedback issue](https://github.com/orphefs/filos/issues/new?template=feedback.yml): what helped, what confused or annoyed you, and anything that looked wrong. If something broke, [report a bug](https://github.com/orphefs/filos/issues/new?template=bug.yml) with the log from **View › Output › Filos**. Issues are public, so leave out private code.

## Commands

| Command | What it does |
| --- | --- |
| **Filos: Review Pull Request…** | Reviews a GitHub pull request, given as a URL, `owner/repo#123` or a number. |
| **Filos: Review Current Branch** | Reviews your workspace's branch against its base. |
| **Filos: Review Current Branch Against…** | The same, against a base branch you choose. |
| **Filos: Review Sample PR (bundled example)** | The bundled sample review. No agent and no cost. |
| **Filos: Review Sample PR with Agent** | Runs your agent on the same sample. |
| **Filos: Choose Agent CLI…** | Chooses Claude Code or Codex for every agent step. |
| **Filos: Delete Pull Request Checkouts** | Deletes the clones Filos keeps for pull-request reviews. |

## Settings

Filos reads these from your user settings only. A repository's `.vscode/settings.json` arrives with the code under review, so it can't choose which program Filos runs or raise its limits.

| Setting | Default | What it does |
| --- | --- | --- |
| `filos.provider` | `claude` | The agent CLI: `claude` (Claude Code) or `codex` (Codex). |
| `filos.claude.path` | `claude` | The `claude` executable: a name on PATH, an absolute path, or `~/…`. |
| `filos.claude.model` | `sonnet` | Claude Code model alias. Empty uses the CLI's default. |
| `filos.claude.maxBudgetUsd` | `1` | Spending cap in US dollars per Claude Code call. |
| `filos.codex.path` | `codex` | The `codex` executable. |
| `filos.codex.model` | empty | Codex model. Empty uses Codex's default. A ChatGPT account can't use every model. |
| `filos.codex.useUserConfig` | `false` | Load `~/.codex/config.toml`, for example for a company model provider. Filos's read-only lockdown still applies. |
| `filos.agentTimeoutSeconds` | `600` | Stops the agent CLI after this many seconds. For Codex, which reports no cost, this is the only bound. |
| `filos.gh.path` | `gh` | The GitHub CLI. |

## Cost and time

Filos runs your own agent CLI, so it uses your plan or API account.

- **Claude Code** (Sonnet): on a 14-file pull request, reading the change took about 5 minutes and cost about $0.90, and writing the questions took about 4 minutes and $0.60. A graded answer or a comment thread costs a few cents. `filos.claude.maxBudgetUsd` caps each call.
- **Codex** reports no dollar cost; runs count against your Codex plan's limits. On the same pull request (Codex's default model, ChatGPT account), reading the change took about 3 minutes and writing the questions about 1.5 minutes.
- You can explore the graph while the questions are being written. The bundled sample costs nothing.

## Privacy and security

- **Your code goes to your model provider.** Filos sends the pull request's code to Anthropic or OpenAI through the CLI you chose, under your account and its terms. Filos itself has no server and collects no telemetry.
- **Filos never handles credentials.** It runs your installed `claude`, `codex` and `gh` with the logins you already have.
- **The agent can only read the code under review:**
  - Claude Code runs with read-only tools (Read, Grep, Glob), no MCP servers, and without the repository's own Claude settings.
  - Codex runs in a sandbox that can read only the checkout. It has no network and can't write, and MCP servers, plugins, skills and the repository's `AGENTS.md` are all off.
  - Either way, every answer is checked against Filos's contracts before you see it.
- **Pull-request code is isolated.** It is cloned into Filos's storage with git hooks disabled. Its files open read-only, so other extensions don't treat it as one of your projects.
- **Nothing is posted without your confirmation,** and only the comments you accepted are posted.
- **Your confidence scores stay private.** How well you know each module is stored only on your machine.

## Known limitations

- Pull requests are supported on GitHub only (GitHub Enterprise through the pull request's URL).
- Filos is tested on Linux, and on macOS by automated tests with stand-in agent CLIs. Windows is untested.
- The Codex sandbox, which confines Codex to reading the code under review, has been checked on Linux only. On macOS it relies on Codex's own sandbox (Seatbelt) applying Filos's settings, which hasn't been checked yet.
- On Ubuntu 24.04 and later, the system's restriction on user namespaces can stop Codex's Linux sandbox from starting, and then Codex can't read the code. If Codex reviews fail that way, use Claude Code (**Filos: Choose Agent CLI…**).
- The graph, questions and comments come from a language model. Check them against the code, as Filos asks you to.

## Building from source

See [docs/development.md](docs/development.md).

## License

[MIT](LICENSE)

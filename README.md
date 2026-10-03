# Filos

*Filos* (Greek: friend) is Socratic PR review for VS Code. It leaves you understanding the code, not just the diff.

**Prototype.** This build covers build-order slices 1–4 and 6 from [CLAUDE.md](CLAUDE.md):

- a graph of the PR's main changes, with risk tinting computed from countable signals,
- click a node to open the relevant code beside the graph, with unrelated regions folded down to one-line gists,
- a comprehension pass run by the `claude` CLI, validated against the [review-graph contract](docs/graph-contract.md),
- questions about the change, draft comments you accept, reject, amend or discuss with the agent, and posting to the PR through `gh` ([question-set contract](docs/questions-contract.md)),
- a whole GitHub pull request, from pointing Filos at it to posting the review, with every agent step run by the `claude` CLI,
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

The sample also opens from a link: `vscode://orphefs.filos/reviewSample`.

The agent runs through your installed CLI (`claude`) and GitHub through `gh`, each with your existing login. Filos never handles credentials.

## The flow

1. **Point Filos at a pull request.** Run **Filos: Review Pull Request…** and pick it, or paste its URL.
2. **Watch the steps.** The panel opens at once with a checklist:
   - *Find the pull request*: `gh pr view`, e.g. "#9 · 14 files · +440 −176".
   - *Get the code*: a blobless clone of the repository in Filos's storage (made once, then only fetched), with the pull request's head checked out in a worktree of its own. Hooks never run there. A closed or merged pull request is compared with its base as it was, as GitHub shows it.
   - *Claude Code reads the change*: the comprehension pass, with its live progress.
   - *Claude Code writes questions*: this one carries on in the side pane once the graph is up.
   If a step fails, it is marked, with what to do (Retry, or Log in again for gh or Claude Code). Cancel stops it.
3. **Explore the graph.** Click a node to open its code beside the graph, folded down to what matters. A pull request's files open read-only, through Filos's own `filos-pr:` file system: no other extension takes the checkout for a project of yours and runs code from it (a linter loading the pull request's `node_modules`, say).
4. **Answer the questions**, in fast mode or in didactic mode (territories in fog until you answer your way in). Claude Code grades open answers.
5. **Shape the comments.** Accept, reject or amend each draft, or open a thread with the agent about it; add your own notes.
6. **Confirm and post.** Filos shows where the review goes and what it says, and posts it through `gh` only when you confirm. A merged or closed pull request can still be reviewed to learn the code; it is not posted to.

**Re-run analysis** fetches the pull request again and keeps your answers and comments. They are kept per pull request, whichever VS Code window you open it from. Several windows can review pull requests at once: each waits for the others when they work on the same clone, and none deletes a checkout another one is showing.

## Develop

```bash
npm install
npm run build        # dist/extension.js, dist/webview.js
npm run test:unit    # contract, risk, provider (fake CLI), review model
npm run test:e2e     # real VS Code, headless under xvfb, with fake claude and gh CLIs
npm run validate:fixture     # the sample graph against the graph contract
npm run validate:questions   # the sample questions against the question-set contract
npm run harness      # webview alone in a browser, mocked host
npm run package      # dist/filos.vsix
```

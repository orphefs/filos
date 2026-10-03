# Filos

*Filos* (Greek: friend) is Socratic PR review for VS Code. It leaves you understanding the code, not just the diff.

**Prototype.** This build covers build-order slices 1–4 and 6 from [CLAUDE.md](CLAUDE.md):

- a graph of the PR's main changes, with risk tinting computed from countable signals,
- click a node to open the relevant code beside the graph, with unrelated regions folded down to one-line gists,
- a comprehension pass run by the `claude` CLI, validated against the [review-graph contract](docs/graph-contract.md),
- questions about the change, draft comments you accept, reject, amend or discuss with the agent, and posting to the PR through `gh` ([question-set contract](docs/questions-contract.md)),
- didactic mode: territories in fog until you answer your way in, with progress as coverage.

Slices 4 and 6 were built autonomously: their UX is provisional ([review-and-didactic.md](docs/review-and-didactic.md)).

## Commands

| Command | What it does |
| --- | --- |
| **Filos: Review Sample PR (bundled example)** | Opens the bundled sample PR with a hand-written graph. No agent and no cost. |
| **Filos: Review Sample PR with Agent** | Runs the agent on the same sample PR. |
| **Filos: Review Current Branch** | Runs the agent on your workspace's branch compared with its base. |

The sample also opens from a link: `vscode://orphefs.filos/reviewSample`.

The agent runs through your installed CLI and your existing login. Filos never handles credentials.

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

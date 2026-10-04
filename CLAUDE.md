# Filos — Socratic review for VS Code

*Filos* (Greek: friend). A VS Code extension for agentic, interactive PR review that leaves the reviewer understanding the codebase better than before.

## Status

**Design phase, with a throwaway-quality prototype to react to.** UX comes first. At Orfeas's request (2026-10-03), build-order slices 1–3, then 4 and 6, were prototyped (now on `main`) so the UX can be judged in real VS Code. Their UX choices are provisional (listed below and in `docs/review-and-didactic.md`), not decided. Beyond the prototype, don't write more extension code until the core screens are agreed. When discussing UX, prefer quick visual mockups (static HTML) over prose.

## The problem

PR review volume keeps growing, and the reviewer's mental model of the codebase gets thinner with every PR skimmed. Existing tools summarise diffs; none try to keep the human's understanding intact. Filos treats review as the occasion for learning the code. The purpose is to keep humans in the loop with a real mental model of what they are changing.

## Core concept

1. **Comprehension pass.** The agent reads the PR diff plus surrounding repo context and produces a graph of the main changes: how they relate and what they affect. An architecture diagram for a diff.
2. **Exploration.** Clicking a node expands it and shows the relevant code beside the graph.
3. **Review.** The agent asks questions about the change; the answers, plus free text, become the review, which is refined and approved before posting.

## Decided

### Shape and scope
- Built as a VS Code extension, because VS Code is code-centric, unlike prompt-centric tools like Claude Code and Codex.
- First use case is a single PR diff, which is bounded. Learning an arbitrary module (no PR) is a later second use case on the same machinery.
- Everything happens inside the extension, including posting comments to GitHub.

### Layout
- Three zones: **graph**, **code pane**, **contextual summary**.
- **First screen:** the graph, already built, with a short orientation paragraph above it (e.g. "touches four modules; the risky one is X because Y"). No questions yet, and no wall of diff.
- **Progressive disclosure:** start at module level, expand into functions.
- **Clicking a node** expands its children in the graph *and* unfolds only the relevant code regions in the code pane. Everything else stays folded.
- **Semantic folding:** folded regions show a one-line gist of what they do, never a blank fold.
- **Summary** rewrites itself for the current selection. It is generated lazily (not precomputed), cached, and adapts to what the user has already looked at.

### Visual language
- Interactive and colourful, with a strong visual hierarchy. It should follow teaching standards to be as didactic as possible.
- Colour carries meaning, not decoration. Example: risky diffs are tinted towards red, and redder means scarier.
- The risk colour aggregates countable signals (e.g. coverage, fan-out, churn, reverts), not the agent's judgement alone.
- A small colour-coded **gutter indicator** beside each snippet shows statistics about it.
- The top-priority signal is **downstream impact**: who consumes this symbol, especially outside this repo. Integration breakage is the main pain point.
- Respect the user's VS Code theme (light and dark).

### Personalisation and learning
- The tool **asks** whether the user is familiar with something rather than assuming. Commit history is not a proxy, since an agent may have written that commit.
- It tracks **confidence per module** instead of grading the user. The score is **private** and stored locally.
- State is small: module path, confidence, last-touched date. No behavioural event log.

### Modes
- **Fast mode:** graph, questionnaire and comments, for getting through PRs quickly.
- **Didactic mode:** asks before telling. It holds a conversation and corrects the user's understanding.
  - Gamified as a little Socrates character walking a map, where the map is the diff.
  - Entering a territory requires answering questions first. Exploring reveals the map.
  - Progress means coverage, not points.

### Review flow
- The agent proposes a review depth based on how important the PR is. The user can override it.
- The review is built from questionnaire answers, with a free-text escape hatch for things the agent didn't notice.
- Per draft comment the user can **accept / reject / amend**, or open a **thread** with the agent to work towards a better final comment for the PR author.
- Nothing posts without explicit approval.

### Downstream impact (decided 2026-10-04; see docs/mockups/downstream-consumers.html)
- **How:** found by live GitHub code search at review time. No index to maintain and no downstream clones.
- **Scope:** by default, the PR's owner or org (excluding the PR's repo itself); more owners can be added.
- **Who searches:** Filos runs the searches. The agent judges each match and may propose a capped number of follow-up searches, which Filos runs. The agent never gets network access.
- **Only on click.** After the graph, the steps pause at "Look for downstream consumers" with **Search GitHub** and **Skip**.
- **Questions wait** for the downstream findings, or for Skip, so they can ask about them.
- **Narrow before reading.** Searches use GitHub's search qualifiers to target likely consumers, and matches are judged from the fragments search returns. Whole downstream codebases are never read.
- **Privacy notice:** shown once per org before the first search, because other repos' snippets go to the agent CLI's model provider.
- **Unsearchable repos (option (a), 2026-10-04).** GitHub's search API (still the legacy engine) only covers repos with activity in the past year, searches only default branches, ignores punctuation, and has no regex. So Filos detects dependents that search can't see and shows them as "not searchable", never as safe. The planned detection: read the root package.json of the org's inactive repos directly, which is not a search. A small-repo download fallback (b) is deferred until gaps matter in practice.
- **Still open** (mockup v3 lists them): search and file-read budgets; the verdict wording ("Breaks / Changes behaviour / Unaffected / Not searchable" is the current proposal); how much an unsearchable dependent weighs in the risk colour; how to cover callers with no package dependency, such as HTTP clients; and the cap on how many inactive repos get checked.

### Architecture
- **Extension:** TypeScript. The UI lives in a webview.
- **Agent:** provider-agnostic (Codex, Claude Code, custom), wrapped behind our own thin interface.
  - Invoke the provider **CLIs** rather than SDKs, so the extension inherits the user's existing login (e.g. company SSO for Codex) and never handles credentials.
  - Fail gracefully when a session expires, and prompt the user to re-authenticate.
- **Agent output** is structured JSON against our own contract, validated on receipt. Do not trust providers to honour the contract.
- **Dependency index:**
  - Prebuilt by a user-owned skill that runs locally. The extension reads the index directly. No MCP server.
  - Format: symbol, consumers, producers.
  - A refresh can be triggered, and the UI shows when the index was last built.
  - With no index, fan-out colouring is unavailable but everything else still works.

## Open questions

- How confidence is measured in practice, and whether and how it decays as code changes.
- Which 2–3 signals go in the gutter indicator.
- The visual metaphor for didactic mode (fog-of-war over unexplored modules is one candidate).
- Exact location and spec of the dependency index format. Write it down as a short spec.
- The JSON contract for the graph (nodes, edges, risk, file/line anchors). This should fall out of the UX.
- How the questionnaire chooses what to ask.

## Prototype

What exists: the bundled sample PR (`fixtures/`), contract v0.1 (`docs/graph-contract.md`, `schema/`), the webview graph and summary, the native-editor code pane with folds and gists, the `claude` CLI provider, unit tests (`npm run test:unit`) and an e2e suite in real headless VS Code (`npm run test:e2e`). The webview alone runs with `npm run harness`.

Measured: the real comprehension pass on the sample PR (10 files) costs about $0.40 and takes 3.5–4.5 minutes with Sonnet. With the CLI's default model (Opus, 1M context) it hit the $1 cap after 4.5 minutes.

### Provisional decisions (made to get it working; Orfeas to confirm or change)

- **Agent defaults:** `--model sonnet`, $1 spending cap, 600 s timeout. The CLI runs with Read/Grep/Glob only, `--setting-sources user` (the reviewed repo's `.claude/` settings are ignored) and no MCP.
- **Agent output:** line-number slips (out-of-range anchors, partially overlapping outline regions) are repaired, and each repair shows as a warning. Structural problems (unknown ids, bad parents, dangling edges) reject the graph. There is no automatic re-prompt.
- **Graph:**
  - Layout direction is chosen automatically (top-down in narrow panes).
  - Clicking a closed module opens it and selects it; only the chevron, ← or Collapse all close it.
  - The wheel zooms. When the stacked panel scrolls, the wheel scrolls the page and Ctrl/Cmd+wheel zooms.
  - Edges of a closed module are lifted to it, with a count bubble.
  - Outside consumers are purple and dashed.
  - Change kind is a monochrome badge, so it doesn't compete with risk red.
- **Risk:** weights in `src/contract/risk.ts`.
  - External consumers count most; agent judgement adds at most 0.15.
  - Bands: medium from 0.25, high from 0.55.
  - A parent takes the colour of its riskiest child.
- **Code pane:**
  - A preview tab in column 2, replaced on each click.
  - Folds use the built-in fold commands. These need the editor focused, so focus flicks to the editor and back.
  - Gists are muted italic text at the end of the fold's first line.
  - The selection's anchors get a whole-line red tint.
- **Workspace trust:** the sample works in Restricted Mode; Review Current Branch needs a trusted workspace (it runs git and the agent CLI there).
- **Dependency index:** `.filos/dependency-index.json`, format drafted in `docs/dependency-index.md`.

### Slices 4 and 6 (questionnaire, comments, posting, didactic mode)

Specified in `docs/review-and-didactic.md`; question contract in `docs/questions-contract.md`; the sample's questions in `fixtures/sample-questions.json`. The main provisional choices:

- **Questions:** two kinds and two stages (understand or judge; predict or check).
  - Multiple choice is graded locally and costs nothing. A first wrong answer gets a Socratic hint and a retry.
  - Open answers are graded by the agent. The sample has no agent, so there the reviewer self-checks against a reference answer.
- **Comments:** judge choices draft comments, and so do agent drafts and reviewer notes. Each can be accepted, rejected, amended or discussed with the agent; "Use this version" adopts the agent's proposal.
- **Posting:** only accepted comments are posted, through `gh api` after a modal confirmation. Comments on lines outside the diff go into the review body. The sample offers Markdown export instead.
- **Didactic mode:**
  - Territories are the top-level modules. Unexplored ones are fogged: only their name shows, with no risk or detail.
  - Entering a territory asks about familiarity (skipped if a stored record exists), then one predict question. The code opens only after that.
  - Socrates stands beside the current territory. Progress is "Explored n of N".
- **Confidence:** stored per module path in `globalState`, holding only module path, confidence and last-touched date. Familiarity sets the start value (0.2 / 0.5 / 0.8). Understand answers then add +0.15 for right first time, +0.05 for right on the retry, and −0.10 for wrong.
- **Depth:** the question set proposes skim, standard or deep, and the depth menu overrides it. The sample's split is 4 / 12 / 14 questions.

### The pull-request flow

"Filos: Review Pull Request…" takes a URL, `owner/repo#n` or a number. It runs these steps, all through the `claude` and `gh` CLIs:

1. Look up the PR.
2. Make an isolated blobless clone and worktree in Filos's storage. Your checkouts are never touched.
3. Run the comprehension pass.
4. Run the questions pass.
5. Go through the questionnaire, then the comments, then a modal confirmation, then post.

PR files open read-only through a `filos-pr:` file system, never as `file:` URIs. That means other extensions and VS Code's Git integration never treat PR content as workspace code.

It was verified live on a private 14-file PR (2026-10-03, Sonnet):
- comprehension: 312 s, $0.86
- questions: 254 s, $0.60
- each graded answer or thread reply: about $0.05 and 8–15 s
- a 2-comment review was posted for real, with explicit approval.

On the same PR with Codex (default model on a ChatGPT account, 2026-10-04):
- comprehension: 179 s, about 159k tokens in (117k cached) and 5k out
- questions: 81 s
- grading, drafting and threads: about 6–7 s each
- no dollar cost is reported.

The first Codex attempt named a parent node it never emitted. The validator now re-attaches such nodes in repair mode instead of rejecting the graph.

Open question from that run: the agent's orientation and Socrates (which follows the counted risk signals) can disagree about which module is riskiest. Which should the guide follow?

### Open UX questions raised by the prototype

- **Gists get cut off:** text at the end of a line falls off-screen in a narrow code column. Options: a CodeLens line above each fold (always visible, but costs a line), a hover only, or a gist that replaces the folded body's first line (needs proposed API).
- **Tint strength:** the whole-line red can be heavy in dark themes. Should it be a left-border or gutter mark instead?
- **Re-run cost:** "Re-run analysis" spends real money even on the sample. Confirm first, or hide it for the sample?
- **Host-driven selection:** should selection (from commands or tests) also open modules? The prototype says yes.
- **Floor for external consumers:** should anything with external consumers be at least medium risk? Today `createInvoiceHandler` (1 consumer) is just under the medium threshold.
- **Lazy summaries:** summaries are currently written in the comprehension pass. Lazy, cached per-selection summaries are still to come.

### Publishing (prepared 2026-10-04)

- **Name:** "Filos" was free on the VS Code Marketplace (no extension uses that display name), and so was the ID `orphefs.filos` (checked 2026-10-04).
- **First release:** Orfeas chose an MIT license, a pre-release 0.1.0 marked as preview, and a public repo (github.com/orphefs/filos).
- **Package:** a listing README with screenshots, an icon (`media/icon.png`, drawn as `media/icon.svg`), a CHANGELOG, and `npm run publish:pre-release`.
- **Steps for Orfeas:** in [docs/development.md](docs/development.md). Make the repo public and push first, so the listing images resolve.
- **Not yet published.** The publisher account and its token are Orfeas's.
- **Sharing with friends first (prepared 2026-10-05):** a v0.1.0 pre-release on GitHub Releases with the `.vsix` attached, installed with "Install from VSIX…". The README has Install and "Trying it out" sections, and feedback comes in through issue forms (`.github/ISSUE_TEMPLATE/`). Release steps are in [docs/development.md](docs/development.md).

## Build order (after UX is settled)

Build in slices the user can look at and react to, not autonomously end to end:

1. Webview rendering the graph from a hand-written JSON file, with no agent. Prove the graph is readable.
2. Click-to-code pane with folding and gists.
3. Replace the fake JSON with a real agent call through the provider interface.
4. Questionnaire, then comment drafting and accept/reject/amend/thread, then posting to GitHub.
5. Risk colouring, gutter indicators, dependency index.
6. Didactic mode.

## Working agreement

- UX and product decisions are Orfeas's. Offer options with trade-offs and let him choose; do not settle design questions silently.
- Keep this file current as decisions are made. Move items from Open questions to Decided.

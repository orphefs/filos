# Filos — Socratic review for VS Code

*Filos* (Greek: friend). A VS Code extension for agentic, interactive PR review that leaves the reviewer understanding the codebase better than before.

## Status

**Design phase.** UX comes first. Do not write extension code until the core screens are agreed. When discussing UX, prefer quick visual mockups (static HTML) over prose.

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
- Name availability on the VS Code Marketplace (check in VS Code's extension search).

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

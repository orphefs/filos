# Questionnaire, comments and didactic mode (slices 4 and 6)

**Status: provisional.** Orfeas asked for these slices to be built autonomously. Every choice below is a proposal for him to confirm or change; none of it belongs in CLAUDE.md's Decided section yet.

Types: `src/contract/questions.ts` (question-set contract v0.1), `src/review/types.ts` (review state), `src/protocol.ts` (`review` snapshot and `ReviewAction` messages), `src/agent/provider.ts` (`ask()` for small agent tasks).

## Principles carried over from CLAUDE.md

- **Answers become the review.** Judgement questions draft comments. There's also a free-text escape hatch for anything the agent didn't notice.
- **Comment controls.** For each draft comment the reviewer can accept, reject or amend it, or open a thread with the agent. Nothing posts without an explicit confirmation.
- **Asking.** The tool asks whether the reviewer is familiar with something; it never infers it. Confidence is tracked per module, it's private and local, and it holds only module path, confidence and last-touched date.
- **Didactic mode.** It asks before telling and corrects understanding. The map is the diff: entering a territory requires answering first, and progress is coverage, not points.
- **Review depth.** The agent proposes a depth and the reviewer can override it.

## Questions

There are two kinds of question:
- **Understand questions** have a right answer and are graded.
- **Judge questions** are the reviewer's call. They are never graded, and a choice may draft a comment.

Questions are also staged:
- **Predict** questions are asked before the code is shown, and form the didactic gate.
- **Check** questions are asked after reading the code.

**Multiple choice** is graded locally: it's instant and costs nothing.
- **Wrong on the first try:** the hint is shown (Socratic: a question back, not the answer), and the reviewer can try again.
- **Wrong on the second try:** the explanation is shown and the question is done.

**Open questions:**
- **Agent available** (agent-sourced review): the agent grades the answer. On a first wrong attempt it replies with a hint; from the second attempt on it explains.
- **No agent** (the sample): the reference answer is shown, and the reviewer self-checks with "I got it" or "I missed something".

**Depth:** skim ⊂ standard ⊂ deep. A question carries the smallest depth that includes it. The proposal comes from the question set (the agent, or the fixture), and the chosen depth is persisted per PR.

**Order:** riskiest node first (by `scoreGraph`), and predict before check within a node.

## Comments

- **Sources:** a judge choice with a `comment` seed, the agent ("Draft comments with agent", from the answers), and the reviewer's own notes.
- **Statuses:** draft, accepted and rejected. "Undo" reopens a comment, and amending sets `amended`.
- **Threads:** the reviewer writes, and the agent replies, optionally with a full rewritten comment as a `proposal`. "Use this version" adopts it as the body.
- **Posting (GitHub, via `gh`):**
  - Only accepted comments are posted.
  - A comment with `file`/`line` on a head line inside the PR's diff becomes an inline comment. Otherwise it goes into the review body, as "`file:line`: …".
  - The host shows a modal confirmation that names the repo, the PR number and the comment count, then calls `gh api repos/{owner}/{repo}/pulls/{n}/reviews` with `event: COMMENT`.
  - The sample has no PR, so its target is `none` with a reason, and Export is offered instead.
- **Export:** Markdown of the accepted comments, plus drafts marked as such. It's copied to the clipboard and opened as an untitled document.

## Didactic mode

- **Territories** are the top-level `module` nodes. External consumers aren't territories: they stay visible but dimmed until a territory that uses them is explored.
- **Fog.** An unexplored territory shows only its name. It has no risk tint, no change badge and no child count, and it can't be expanded. Edges into fog are faint. Exploring reveals the map.
- **Entering a territory.** Clicking a fogged territory sends `enter` and opens a gate in the side pane, in two steps:
  1. **Familiarity.** "Have you worked with money before?" with the answers New to me / Somewhat / I know it well. This step is skipped when a stored confidence record exists for that module path, because the reviewer answered it before.
  2. **Predict question.** The territory's first predict question at the chosen depth. If it has none, the gate asks an open "What do you expect this change to affect?" question, which is noted and never graded.
- **After the prediction.** Answering it marks the territory explored, and the feedback stays visible. "Continue into money" sends `select` for the territory: the host clears the gate, the webview expands it, and the code opens.
- **Socrates.** A small SVG figure stands beside the territory being entered or last explored, and walks there with a short transition. A one-line speech bubble says what is happening. It is never decorative noise: no idle animation.
- **Progress** is coverage: "Explored 2 of 4 territories". Per-territory confidence shows as a small private meter in the territory's summary. There are no points.
- **Inside an explored territory,** its check questions appear in the side pane for the selected node.

## Confidence (private, local)

- **Storage:** `globalState["filos.confidence.v1"]`, as `{ [repoKey]: { [modulePath]: { confidence, lastTouched } } }`.
  - `repoKey` is `sample:@acme/ledger` for the sample, and otherwise the normalised `origin` URL, or failing that the repo root path.
  - `modulePath` is the longest common directory of the module's anchors, or its node id if it has no anchors.
- **Starting value:** taken from familiarity: new 0.2, some 0.5, known 0.8. If there's a stored value, that is used instead.
- **Understand answers:**
  - correct on the first try: +0.15
  - correct on the second try: +0.05
  - partly correct: +0.05
  - incorrect in the end: −0.10
  - The result is clamped to 0..1, and `lastTouched` is updated.
- **Decay** is an open question. `lastTouched` is stored so decay can be added later.

## Agent tasks (`ask()`)

Each task has its own schema and validator, and each prompt treats the diff, code and answers as data.

| Task | Tools | Input | Output |
| --- | --- | --- | --- |
| `questions` | read | graph, diff, dependency index | `QuestionSet` (node ids must exist; choice rules) |
| `evaluate` | none | question, reference/choices, node summary, code excerpt, answer, attempt | `{ verdict, reply, comment? }` |
| `draftComments` | none | graph summary, answered questions, notes, existing drafts | `{ comments: [...] }`, new ones only |
| `thread` | none | comment, node summary, code excerpt, thread, message | `{ reply, proposal? }` |

- **When questions are generated:** for an agent-sourced graph, the `questions` task starts as soon as the graph loads, and the snapshot shows `questionsStatus: loading` until it finishes. The sample uses `fixtures/sample-questions.json`.
- **Cost:** agent-graded open answers and threads cost a few cents each. In the sample nothing calls the agent unless the reviewer clicks a button that says it will.

## Persistence

- **Per PR** (`workspaceState`, same key as the view state): chosen depth, answers, comments, explored territories and familiarity answers.
- **Global** (`globalState`): mode (fast or didactic) and the confidence store.

# Question-set contract v0.1

**Status: provisional.** It's built autonomously with slices 4 and 6. [review-and-didactic.md](review-and-didactic.md) says how the questions are asked, graded and turned into comments. This page says what a question set must contain. Change the types, the schema and this page together.

| Source of truth | File |
| --- | --- |
| Types | `src/contract/questions.ts` |
| JSON Schema | `schema/question-set.schema.json` (exported as `QUESTION_SET_SCHEMA`) |
| Validator (schema + semantic checks) | `src/contract/validateQuestions.ts` (`validateQuestionSet`) |
| Worked example | `fixtures/sample-questions.json`, for `fixtures/sample-graph.json` |

A question set belongs to one review graph: every question is about a node of that graph. The bundled sample's set is hand-written. For an agent-sourced graph, the agent's `questions` task writes it (`src/agent/tasks.ts`). The schema sticks to plain keywords: no `$ref` and no `const`, so it can go to a CLI's `--json-schema` unchanged. Pass it through `toCliSchema` anyway, as for the graph.

## Top level

| Field | Type | Notes |
| --- | --- | --- |
| `contractVersion` | `"0.1"` | Exact match. |
| `depth` | `{ proposed, why }` | The proposed review depth (`skim`, `standard` or `deep`) and one sentence (≤ 300 chars) on why, from how important and risky the PR is. The reviewer can override it. |
| `questions` | `Question[]`, 1–40 | Order doesn't matter: the host asks the riskiest node first, and predict before check within a node. |

## Questions

| Field | Notes |
| --- | --- |
| `id` | Unique within the set, ≤ 80 chars, stable (answers are stored under it), e.g. `q-money-predict`. |
| `nodeId` | An existing graph node: a module, a symbol or an external. |
| `stage` | `predict` is asked before the code is shown, and a module's predict question is the didactic gate into that territory. `check` is asked after the reviewer has read the code. |
| `purpose` | `understand` has a right answer, is graded, and feeds the private confidence score. `judge` is the reviewer's call: it's never graded, and its choices may draft comments. |
| `depth` | The smallest depth that includes the question (see Depth). |
| `prompt` | ≤ 600 chars. Plain text, never rendered as HTML or trusted markdown. |
| `choices` | 2–6 choices make it multiple choice, graded locally. Absent makes it an open question with a free-text answer. |
| `reference` | Open questions: what a good answer covers. Shown for self-checks, used by agent grading. ≤ 1500 chars. |
| `hint` | Shown after a wrong first attempt, so only `understand` questions use it. Write it as a question that points the way, never the answer. ≤ 300 chars. |

### Choices

| Field | Notes |
| --- | --- |
| `id` | Unique within its question, ≤ 40 chars. |
| `text` | ≤ 300 chars. |
| `correct` | `understand` only. At least one choice is `true`. |
| `explain` | Required on every choice and shown once it's chosen. For a right choice, why it's right. For a wrong choice, why it's wrong, not just "no". For a judge choice, what follows from that judgement. ≤ 800 chars. |
| `comment` | `judge` only: choosing this choice drafts the comment seed below. |

### Comment seeds

```ts
{ file: "src/money/round.ts", line: 18, severity: "blocking", body: "This changes the default rounding for every caller…" }
```

- `body` (≤ 4000 chars) is written to the PR author. It should be polite, specific, and carry the concrete numbers that make the point.
- `severity` is `blocking`, `suggestion`, `question` or `nit`.
- `file` is repo-relative, in the head revision, and `line` is 1-based, as for anchors in [graph-contract.md](graph-contract.md). Both are optional:
  - With `file` and `line`, the comment is inline.
  - With `file` alone, it's a file-level comment.
  - With neither, the comment goes in the review body.
- When posting, a `line` on a head line inside the PR's diff becomes an inline comment. Any other line goes into the review body as "`file:line`: …". Prefer a line the PR adds or changes.

## Depth

`skim` ⊂ `standard` ⊂ `deep`. A question at depth *d* is asked whenever the chosen depth is *d* or deeper.

| Depth | What belongs there |
| --- | --- |
| `skim` | The 3–4 questions a reviewer in a hurry must not miss: the riskiest change's predict question, and the judge questions behind the PR's real concerns. |
| `standard` | Adds a predict question for every changed module, and the multiple-choice and open check questions that build a working model of the change, downstream consumers included. |
| `deep` | Adds the rest: subtler checks and lower-stakes judgements. |

The proposed depth should include at least one question, or the review starts empty. The validator warns if it doesn't.

## Validation

`validateQuestionSet(input, graph, { readFile?, repair? })` checks the schema first and then the rules below. It never mutates its input. It returns a canonical copy, or the errors.

| Rule | Strict (fixtures) | Repair (agent output) |
| --- | --- | --- |
| Matches the schema | error | error |
| Question ids are unique | error | drops the later duplicates |
| `nodeId` exists in the graph | error | drops the question |
| Multiple choice has ≥ 2 choices with unique ids | error | drops the question |
| An `understand` multiple-choice question has a correct choice | error | drops the question |
| No `correct` on `judge` choices | error | strips it |
| No `comment` on `understand` choices | error | strips it |
| A comment `file` is repo-relative (`./a` and `a\b` are canonicalised) and, with `readFile`, exists | error | drops `file` and `line`, keeps the body |
| A comment `line` has a `file` and, with `readFile`, lies within it | error | drops `line`, keeps a file-level comment |
| Something is left after repairs | n/a | error |
| An open `understand` question has a `reference` | warning | warning |
| The proposed depth includes a question | warning | warning |

Every repair becomes a `repaired: …` warning. Without `readFile`, paths are still canonicalised, but files and line bounds aren't checked. The agent task adds what only the agent path needs: absolute paths rebased under the repo, a question cap, and a warning for a changed module with no predict question.

## Writing good questions

The sample follows these conventions. The agent's prompt should ask for the same.

- **Predict questions** are about consequences, and can be answered from the PR description, the orientation and general reasoning, before any code is shown. For example: "three repos call roundToCents without a mode; what happens when they upgrade?"
- **Check questions** are about specifics visible in the code: a branch, a fallback, an operator, the order of operations.
- **Use concrete numbers.** "12.5 cents → 12, not 13" teaches more than "ties round differently". Every number must be true of the head revision, so check it by running the code.
- **Wrong choices** are plausible misreadings, such as the old behaviour, an off-by-one or a misread operator. Each one's `explain` names the misreading.
- **Judge questions** have one "fine as is" choice without a comment, so not commenting is always an option. The other choices differ in stance (request, suggest, ask), and that stance sets their severity.
- **Externals:** ask at least one question about a consumer outside the repo whenever the graph has one. Downstream impact is the top-priority signal.

## Checking the sample

```
npx tsx scripts/validate-questions.ts fixtures/sample-questions.json --graph fixtures/sample-graph.json --repo fixtures/sample-repo/head
```

The unit tests (`test/unit/validateQuestions.test.ts`) also hold the sample to these rules:
- It passes strictly with no warnings.
- Every module has a predict question.
- Depth counts are 4 at skim, 12 at standard and 14 at deep.
- Each judge question has exactly one choice without a comment.
- Every comment sits on a line the PR changes.

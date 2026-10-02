# Review-graph contract v0.1

**Status: draft.** This is what the comprehension pass returns and what the webview renders. It should fall out of the UX: expect fields to change once people have clicked around the prototype. Change the types, the schema and this page together.

| Source of truth | File |
| --- | --- |
| Types | `src/contract/graph.ts` |
| JSON Schema | `schema/review-graph.schema.json` |
| Validator (schema + semantic checks) | `src/contract/validate.ts` |
| Risk score | `src/contract/risk.ts` |
| Worked example | `fixtures/sample-graph.json` (head tree in `fixtures/sample-repo/head`) |

Check a graph with `npx tsx scripts/validate-graph.ts <graph.json> --repo <head-dir>` (`npm run validate:fixture` for the sample).

## Purpose

One JSON document describes a PR as an architecture diagram of the diff. It covers the main changes, how they relate, who consumes them, and how risky each one is. It also says which code regions to unfold when a node is clicked, and a one-line gist for every region that stays folded. Agent output is untrusted: the host validates it against this contract on receipt and never renders an invalid graph.

## Top level

| Field | Type | Notes |
| --- | --- | --- |
| `contractVersion` | `"0.1"` | Exact match. |
| `pr` | `{ title, base, head, author?, url? }` | `base`/`head` are branch names or refs. |
| `orientation` | string, ≤ 600 chars | 1–3 sentences above the graph: what the PR touches and where the risk is. |
| `nodes` | `GraphNode[]`, ≥ 1 | See below. |
| `edges` | `GraphEdge[]` | See below. |
| `files` | `FileOutline[]` | One outline per touched file: foldable regions and their gists. |
| `generatedBy` | `{ provider, model?, at? }` | Optional provenance. |

## Nodes

| Field | Notes |
| --- | --- |
| `id` | Unique. Stable across re-runs where possible (see Ids). |
| `label` | ≤ 80 chars, shown on the node. Symbols end in `()`, e.g. `Money.multiply()`. |
| `kind` | `module`, `file`, `function`, `class`, `type`, `external`. |
| `parent` | Containing node id. Required for everything except `module` and `external`, which are top level. |
| `change` | `added`, `modified`, `removed`, or `context` (unchanged code needed to understand the change). |
| `risk` | `{ signals, judgement?, why }`: see Risk. |
| `summary` | 2–4 sentences for the summary pane: what changed, why it matters, what the reviewer should check. |
| `anchors` | Code regions this node is about, in the head revision. Empty for externals. |

**Nesting.** Only `module`, `file` and `class` may contain nodes, which gives progressive disclosure: module → (file) → class → method. Use a module as the direct parent of functions unless a module has several files and grouping by file helps. Methods may sit directly under a module with a qualified label (`Invoice.total()`), as in the sample.

**Ids.** These are derived from names, never from positions: `money` for a module, `money/roundToCents` and `money/Money.multiply` for symbols, `ext/checkout-web` for externals. A file node would be `invoice/discount.ts`.

**Modules** carry the primary anchor of each changed child, so a collapsed module still unfolds what changed inside it.

**Externals** are consumers outside this repo, usually one per repo from the dependency index ([dependency-index.md](dependency-index.md)). They have no anchors; their summary says what they call and where.

## Anchors and line numbers

```ts
{ file: "src/money/round.ts", startLine: 18, endLine: 30, symbol: "roundToCents" }
```

- Paths are repo-relative and use forward slashes. Lines are **1-based and inclusive** in the **head** revision.
- `startLine` is the declaration line itself (`export function roundToCents(`), not the doc comment above it.
- `endLine` is the line that closes the declaration: its `}`, `};`, `];` or final `;`. A one-line declaration has `startLine === endLine`.
- `symbol` is the declared name; class members are qualified (`Money.multiply`, `Money.constructor`). Its last segment appears on `startLine`. It exists so lines can be re-resolved if they drift; nothing does that yet.
- The first anchor is the primary one (the declaration). Later anchors are supporting code: a private helper, the type it returns, or the tests that pin it. Test anchors have no `symbol` and may span several consecutive `test()` blocks.
- An anchor with a `symbol` should match a region with the same symbol in that file's outline exactly, so clicking a node unfolds exactly one fold.

## File outlines and gists

```ts
{ path: "src/money/money.ts", regions: [{ startLine: 36, endLine: 38, symbol: "Money.multiply", gist: "scales by a factor and rounds ..." }] }
```

- One outline per touched file, plus any test file that is anchored. Regions cover every top-level declaration; an imports block can be a single region.
- Regions follow the anchor line conventions. They may **nest** (a class and its methods) but must not **partially overlap**.
- A gist is shown in place of folded code, so it says what the code *does*: present tense, ideally ≤ 100 chars (the schema's hard limit is 140). Never leave a fold blank.

## Edges

```ts
{ from: "money/Money.multiply", to: "money/roundToCents", kind: "calls", label: "rounds the product" }
```

Direction is always **from the dependent to the thing it depends on or acts on**.

| Kind | Meaning |
| --- | --- |
| `calls` | `from` calls `to`. |
| `imports` | `from` depends on `to` without calling it (types, constants). |
| `consumes` | An external uses a symbol in this repo (`ext/* → symbol`). |
| `tests` | A test node exercises `to`. |
| `affects` | Any other influence, e.g. a config value or a data shape. |

Edges are declared once, between the most specific nodes they are true for (symbol → symbol, external → symbol). There are no duplicate module-level edges. **Proposal:** while a node is collapsed, the renderer lifts its edges to the nearest visible ancestor and merges duplicates, so the first screen still shows `checkout-web → money`. Labels are optional and short.

## Risk

The colour comes from countable **signals**. The agent's **judgement** is one damped input, never the whole story. Any signal may be omitted: omitted means *unknown*, not zero. With no dependency index, for example, `externalConsumers` is left out rather than set to 0.

| Signal | Counting convention (as used in the sample) | Points |
| --- | --- | --- |
| `externalConsumers` | Distinct repos outside this one that use the symbol (dependency index). | 0.4 × min(1, n/3) |
| `publicApi` | Reachable from the package entry point (`src/index.ts`); methods of an exported class count. | 0.1 |
| `internalFanOut` | Production call sites in this repo. Tests and the entry point's re-exports are excluded, since `publicApi` already covers exposure. | 0.15 × min(1, n/10) |
| `behaviourChange` | This node's own diff changes what existing callers observe for existing inputs. Purely additive changes (a new optional parameter or field, a new function) and behaviour inherited from a dependency don't count, because the edge carries that. So `context` nodes are `false`. | 0.15 |
| `hasTests` | Existing tests execute this code. Only `false` scores; unknown scores nothing. | 0.1 when `false` |
| `linesChanged` | Lines added + removed inside the node's anchors. Modules sum their files. | 0.05 × min(1, n/200) |
| `testsChanged` | Tests that target this node changed in the PR. | Not scored; for display. |
| `judgement` | The agent's own 0..1 estimate. Use it for risk the signals miss rather than counting them again. | 0.15 × j |

`level` is the sum, clamped to 0..1. The band is **high** at ≥ 0.55, **medium** at ≥ 0.25, otherwise **low**. `scoreGraph` then raises every ancestor to at least its riskiest descendant (deepest first) and records `inheritedFrom`. The parent keeps its own contributions, so the UI can explain both. Externals carry empty signals and score 0. `why` is one sentence that says why the node is or isn't risky.

The weights are provisional; downstream impact dominates by design. In the sample, `roundToCents` scores 0.80 (high) and `Invoice.total` 0.38 (medium). `createInvoiceHandler` scores 0.24 (low): its external consumer plus public API already put it at 0.233, just under the medium line.

## What the validator enforces

**Errors** (the graph is rejected):
- Anything the schema forbids: missing required fields, unknown fields or enum values, `contractVersion` other than `"0.1"`, an empty `nodes`, line numbers below 1, and over-long `orientation`, `label` or `gist`.
- Duplicate node ids, or duplicate file outlines.
- A `module`/`external` with a parent; any other kind without one; an unknown parent; a parent that is not a `module`, `file` or `class`; parent cycles.
- Edges whose `from` or `to` is not a node.
- An anchor or region that ends before it starts; regions that partially overlap.
- With the head tree available: an anchor or region in a file that does not exist, or that runs past the end of the file.

**Warnings** (the graph renders):
- An external with anchors (they are ignored).
- A non-module node with no anchors (clicking it shows no code).
- A self-edge (ignored).
- An anchor in a file with no outline (no folds or gists there).

The validator does **not** check that a line range lands on the declaration it names. The sample was checked with a throwaway script that asserts this, and an agent pass will need the same check (or re-resolution by `symbol`) before its anchors can be trusted.

## Open questions

- Should the contract keep pure line ranges, or should the host re-resolve anchors from `symbol` and only use lines as a hint?
- Should folds include the doc comment above a declaration? They currently start at the declaration line, so doc comments stay visible between folds.
- `removed` nodes have nothing to anchor in head. Do they get base-revision anchors?
- How should externals be tinted? By the risk of what they consume, or kept neutral as now?
- Should `testsChanged` score? Should a node with external consumers have a floor at medium? The handler in the sample sits 0.007 below the line.
- Should edge lifting live in the contract or stay a renderer rule?
- Should context nodes carry signals at all, or only a `why`?

# Dependency index

**Status: draft proposal.** The location and format are open questions in `CLAUDE.md`. This page proposes an answer to react to. The example lives at `fixtures/sample-repo/head/.filos/dependency-index.json`.

## Purpose

The index records, for each symbol, who consumes it and what it uses, especially consumers **outside this repo**, because integration breakage is the main pain point. Filos turns it into the `externalConsumers` and `internalFanOut` risk signals and the `external` nodes of the review graph ([graph-contract.md](graph-contract.md)).

A **user-owned skill** builds it locally, by scanning this repo and whichever other repos the user has cloned or can search. The extension only reads the file. There is no MCP server and no network call.

## Location

`.filos/dependency-index.json` at the repository root (**provisional**). It is per-user data built from what that user can see, so it should probably be git-ignored. Committing it is an open question.

## Format

```jsonc
{
  "version": 1,                              // format version; bump on breaking changes
  "repo": "acme/ledger",                     // this repo, as consumers elsewhere name it
  "builtAt": "2026-09-30T16:42:00Z",         // ISO 8601, UTC
  "builtBy": "filos-index skill 0.1",        // tool and version, shown in the UI
  "ref": "feature/bankers-rounding",         // optional: branch or commit the index was built from
  "scannedRepos": ["acme/checkout-web"],     // optional: external repos searched (see below)
  "symbols": [
    {
      "symbol": "src/money/round.ts#roundToCents",
      "kind": "function",                    // function | method | class | type | const
      "consumers": [
        { "path": "src/money/money.ts", "line": 37, "symbol": "Money.multiply", "kind": "call" },
        { "repo": "acme/checkout-web", "path": "src/cart/totals.ts", "line": 41, "symbol": "cartTotal", "kind": "call" }
      ],
      "producers": []
    }
  ]
}
```

**Symbol ids** take the form `<repo-relative path>#<name>`, with class members qualified: `src/money/money.ts#Money.multiply`.

**References** share one shape: `{ repo?, path, line?, symbol?, kind, detail? }`.

| Field | Meaning |
| --- | --- |
| `repo` | Absent means this repo. Otherwise `owner/name`. |
| `path`, `line` | Repo-relative path in that repo; 1-based line, optional. |
| `symbol` | For a consumer: the enclosing symbol at the use site, if known. For a producer: the used symbol's name. |
| `kind` | `call`, `import` (including re-exports and type-only use), or `http` (a network client of an endpoint this symbol serves). |
| `detail` | Optional free text, e.g. `"POST /invoices"` for `http`. |

- **`consumers`**: places that use this symbol. `path`/`line` is the use site.
- **`producers`**: what this symbol uses. `path`/`line` is the used symbol's declaration.

**`scannedRepos`** separates "no consumers" from "not looked". The UI can say *0 consumers in the 4 repos scanned*, not just *0 consumers*.

## How Filos uses it

- `externalConsumers` = the number of distinct `repo` values among a symbol's consumers.
- `internalFanOut` = the in-repo consumers of kind `call` (the entry point's re-exports are `import`).
- Each external repo that consumes a changed symbol becomes an `external` node, with a `consumes` edge to that symbol.
- **Pull requests** (**Review Pull Request…**): the index is read from where the pull request branched off (the merge base), never from its head, whose copy the PR's author can write (one that says a risky symbol has no consumers, say). A pull request that changes anything under `.filos/` gets a warning saying so.
- The file is untrusted input, like agent output: it is validated on read, and a malformed index counts as absent, plus a warning.

## "Last built"

The graph header shows one quiet line, e.g. *Dependency index: built 3 days ago from `feature/bankers-rounding` (filos-index skill 0.1)*, with a **Refresh** action. Refresh runs the user's skill command, then re-reads the file. How that command is configured is still open; a `filos.index.command` setting is one option. The line turns into a warning when the index is older than a threshold (7 days, say) or `ref` differs from the PR head.

## When there is no index

Everything else still works. `externalConsumers` is **omitted** (unknown), not set to 0, so downstream impact doesn't colour the graph and no external nodes appear. The header says *No dependency index: downstream impact unknown*, with an action to build one. The agent may still mention consumers it finds by itself, but they don't count as index data.

## Open questions

- Commit the index or git-ignore it? Should one index be shared per org?
- How does the skill find other repos: local clones, code search, a package registry? Does `scannedRepos` cover that?
- Incremental refresh and size limits for large monorepos.
- Line drift: should consumers carry `symbol` only and resolve lines lazily?
- Detecting `http` consumers reliably (route strings, OpenAPI clients).

# fake-gh

A stand-in for the GitHub CLI (`gh`), for unit and e2e tests. It never talks to GitHub. Point the
user setting `filos.gh.path` at the **absolute** path of `gh` here (a `#!/usr/bin/env node` script,
`chmod +x`), or pass it as `gh` to the functions in `src/host/github.ts`.

## What it answers

| Command | `ok` answer |
|---|---|
| `pr view --json <fields>` | the requested fields of `{number: 42, url: https://github.com/acme/ledger/pull/42, headRefOid: <git rev-parse HEAD in cwd>, baseRefName: main, state, title}` |
| `repo view --json <fields>` | `{nameWithOwner: acme/ledger, url}` |
| `api … -X POST repos/<o>/<r>/pulls/<n>/reviews --input -` | reads the JSON on stdin, checks `event: COMMENT`, `body`, `comments`, answers `{id: 1001, html_url: …#pullrequestreview-1001, state: COMMENTED}` |
| `auth status`, `--version` | logged in; a fake version |

Anything else fails with exit 2.

## Environment

| Variable | Effect |
|---|---|
| `FAKE_GH_MODE` | `ok` (default), `auth` (not logged in: exit 4 with gh's message, for every command), `nopr` (`pr view`: no pull request for the branch), `noremote` (`pr view`: no GitHub remote), `apierror` (`api`: HTTP 422 with GitHub's JSON error body), `slow` (waits `FAKE_GH_DELAY_MS`, default 60000, then `ok`). |
| `FAKE_GH_MODE_FILE` | A file holding the mode, read on every call; beats `FAKE_GH_MODE` when present and not empty. |
| `FAKE_GH_RECORD` | Appends one JSON line per call: `{argv, cwd, mode, stdin?}` (`stdin` only for `api --input -`). |
| `FAKE_GH_REPO`, `FAKE_GH_HOST`, `FAKE_GH_PR_NUMBER`, `FAKE_GH_BASE` | Change the answered owner/repo, host, PR number and base branch. |
| `FAKE_GH_HEAD_OID` | The PR's head commit, instead of `git rev-parse HEAD` in the cwd. |
| `FAKE_GH_PR_URL` | The PR URL `pr view` returns, e.g. a malformed one to exercise the `repo view` fallback. |

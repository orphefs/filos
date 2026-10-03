# fake-gh

A stand-in for the GitHub CLI (`gh`), for unit and e2e tests. It never talks to GitHub. Point the
user setting `filos.gh.path` at the **absolute** path of `gh` here (a `#!/usr/bin/env node` script,
`chmod +x`), or pass it as `gh` to the functions in `src/host/github.ts`.

## What it answers

| Command | `ok` answer |
|---|---|
| `pr view [<url>] --json <fields>` | the requested fields of `{number: 42, url: https://github.com/acme/ledger/pull/42, headRefOid: <git rev-parse HEAD in cwd>, baseRefName: main, state: OPEN, headRefName: <current branch>, title}`; with a PR URL, that PR's number and URL |
| `pr view <url \| n \| #n> [--repo o/r] --json <fields>`, with `FAKE_GH_PR_JSON` set | the requested fields of the fixture pull request with that number; none: gh's "Could not resolve to a PullRequest" (exit 1) |
| `pr list --json <fields> [--limit n]` | the requested fields of each pull request in `FAKE_GH_PR_LIST` (a JSON array), else the open ones in `FAKE_GH_PR_JSON`, else `[]` |
| `repo clone [<host>/]<owner>/<repo> <dir> [-- <git flags>]` | `git clone <git flags> file://$FAKE_GH_REMOTE <dir>` (over file://, so `--filter=blob:none` makes a real partial clone). As gh does, origin is `https://<host>/<owner>/<repo>.git`, the host being `GH_HOST`'s (else github.com) when the name has none; an `insteadOf` in the clone's config sends fetches from that URL to the local repository |
| `repo view --json <fields>` | `{nameWithOwner: acme/ledger, url}` |
| `api … -X POST repos/<o>/<r>/pulls/<n>/reviews --input -` | reads the JSON on stdin, checks `event: COMMENT`, `body`, `comments`, answers `{id: 1001, html_url: …#pullrequestreview-1001, state: COMMENTED}` |
| `auth status`, `--version` | logged in; a fake version |

Anything else fails with exit 2.

`makeRemote.ts` builds what `repo clone` clones: a bare repository from `fixtures/sample-repo`
(base on `refs/heads/main`, head on `refs/heads/feature/bankers-rounding` and `refs/pull/9/head`,
filters allowed) and a `pr.json` for `FAKE_GH_PR_JSON` with the real commit ids. Unit tests import
`makeRemote`, `pushToPullRequest` (the author pushes again) and `hookTemplate` (a `GIT_TEMPLATE_DIR`
whose hooks leave a trace if they ever run); from a shell:
`npx tsx test/fixtures/fake-gh/makeRemote.ts <out-dir>` prints `{remote, prFile, headOid, baseOid}`.

## Environment

| Variable | Effect |
|---|---|
| `FAKE_GH_MODE` | `ok` (default), `auth` (not logged in: exit 4 with gh's message, for every command), `nopr` (`pr view`: no pull request for the branch), `noremote` (`pr view` without a URL or `--repo`, `pr list`: no GitHub remote), `apierror` (`api`: HTTP 422 with GitHub's JSON error body), `api502` (`api`: records the request, then HTTP 502), `apislow` (`api`: records the request, then waits `FAKE_GH_DELAY_MS`), `slow` (waits `FAKE_GH_DELAY_MS`, default 60000, then `ok`). With `FAKE_GH_PR_JSON`: `notfound` (`pr view`: no such pull request), `noaccess` (`pr view`: no such repository), `sso` (`pr view`: SAML enforcement), `network` (`pr view`, `pr list`, `repo clone`: can't connect), `clonefail` (`repo clone`: repository not found, exit 128). |
| `FAKE_GH_MODE_FILE` | A file holding the mode, read on every call; beats `FAKE_GH_MODE` when present and not empty. |
| `FAKE_GH_RECORD` | Appends one JSON line per call: `{argv, cwd, mode, ghHost?, ghRepo?, stdin?}` (`ghHost`/`ghRepo`: `GH_HOST`/`GH_REPO` when set; `stdin` only for `api --input -`). |
| `FAKE_GH_UNKNOWN_FIELDS` | Comma-separated `--json` fields this gh doesn't know (e.g. `baseRefOid`, as gh 2.45): asking for one fails like gh does, with `Unknown JSON field: "<field>"` (exit 1). |
| `FAKE_GH_REPO`, `FAKE_GH_HOST`, `FAKE_GH_PR_NUMBER`, `FAKE_GH_BASE` | Change the answered owner/repo, host, PR number and base branch. |
| `FAKE_GH_HEAD_OID` | The PR's head commit, instead of `git rev-parse HEAD` in the cwd. |
| `FAKE_GH_STATE`, `FAKE_GH_HEAD_REF` | The PR's state (default `OPEN`; e.g. `MERGED`) and head branch (default: the current branch). |
| `FAKE_GH_PR_URL` | The PR URL `pr view` returns, e.g. a malformed one to exercise the `repo view` fallback. |
| `FAKE_GH_PR_JSON` | A JSON file with one pull request or an array of them, as `gh pr view --json` gives them (see `makeRemote.ts`). Switches `pr view` to answer from it. |
| `FAKE_GH_PR_LIST` | A JSON file with the array `pr list` answers. |
| `FAKE_GH_REMOTE` | The local bare repository `repo clone` clones. |

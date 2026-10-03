// GitHub posting through gh, driven with the fake gh (test/fixtures/fake-gh): finding the PR, the
// reasons there's none, the exact gh argv and stdin JSON of a post, and what goes inline.
// Nothing here talks to GitHub.

import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { after, beforeEach, describe, it } from 'node:test';
import {
  confirmationText,
  detectPullRequest,
  GhError,
  INLINE_ONLY_BODY,
  inlineMismatch,
  parsePullRequestUrl,
  planPost,
  postReview,
  postTargetOf,
  PR_VIEW_FIELDS,
  pullRequestFromView,
  repoFromView,
  reviewRequest,
  type GhOptions,
  type PullRequest,
} from '../../src/host/github';
import { diffHeadLines } from '../../src/review/github';
import type { DraftComment } from '../../src/review/types';

const FAKE_GH = resolve(__dirname, '../fixtures/fake-gh/gh');
const FIXTURES = resolve(__dirname, '../../fixtures');
const OID = 'a'.repeat(40);
const OTHER_OID = 'b'.repeat(40);

const scratch = mkdtempSync(join(tmpdir(), 'filos-gh-'));
after(() => rmSync(scratch, { recursive: true, force: true }));
const RECORD = join(scratch, 'record.jsonl');

interface Call {
  argv: string[];
  cwd: string;
  mode: string;
  stdin?: string;
}

function calls(): Call[] {
  if (!existsSync(RECORD)) return [];
  return readFileSync(RECORD, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Call);
}

/** Options for the fake: its mode and extra answers through the environment, recording every call. */
function opts(env: Record<string, string> = {}, over: Partial<GhOptions> = {}): GhOptions {
  return { gh: FAKE_GH, cwd: scratch, env: { ...process.env, FAKE_GH_RECORD: RECORD, FAKE_GH_HEAD_OID: OID, FAKE_GH_MODE: 'ok', ...env }, ...over };
}

const PR: PullRequest = { host: 'github.com', owner: 'acme', repo: 'ledger', number: 42, url: 'https://github.com/acme/ledger/pull/42', headRefOid: OID, baseRefName: 'main' };

const comment = (over: Partial<DraftComment>): DraftComment => ({
  id: 'c1',
  body: 'A comment.',
  severity: 'suggestion',
  origin: { kind: 'note' },
  status: 'accepted',
  amended: false,
  thread: [],
  ...over,
});

/** The sample PR's diff with repo-relative paths (git diff --no-index prefixes base/ and head/). */
function sampleHeadLines(): Map<string, Set<number>> {
  const out = spawnSync('git', ['diff', '--no-index', '--no-ext-diff', '--no-color', '--src-prefix=a/', '--dst-prefix=b/', 'base', 'head'], { cwd: join(FIXTURES, 'sample-repo'), encoding: 'utf8' });
  assert.equal(out.status, 1, `git diff --no-index should report differences: ${out.stderr}`);
  return new Map([...diffHeadLines(out.stdout)].map(([k, v]) => [k.replace(/^head\//, ''), v]));
}

beforeEach(() => rmSync(RECORD, { force: true }));

describe('detectPullRequest (fake gh)', () => {
  it('finds the branch PR with one `gh pr view --json` call in the repo', async () => {
    const r = await detectPullRequest(opts());
    assert.deepEqual(r, { ok: true, pr: PR });
    const c = calls();
    assert.equal(c.length, 1);
    assert.deepEqual(c[0].argv, ['pr', 'view', '--json', PR_VIEW_FIELDS]);
    assert.equal(c[0].cwd, scratch);
    assert.deepEqual(postTargetOf(r), { kind: 'github', repo: 'acme/ledger', number: 42, url: 'https://github.com/acme/ledger/pull/42' });
  });

  it("reports the head commit gh gives, here the checkout's own HEAD", async () => {
    const repo = join(scratch, 'repo');
    const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t.invalid', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
    execFileSync('git', ['init', '-q', repo], { env });
    writeFileSync(join(repo, 'a.txt'), 'a\n');
    execFileSync('git', ['-c', 'commit.gpgsign=false', 'add', '-A'], { cwd: repo, env });
    execFileSync('git', ['-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'a'], { cwd: repo, env });
    const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
    const r = await detectPullRequest({ gh: FAKE_GH, cwd: repo, env: { ...process.env, FAKE_GH_RECORD: RECORD } });
    assert.ok(r.ok);
    assert.equal(r.pr.headRefOid, head);
  });

  it('not logged in: a reason that says to run gh auth login', async () => {
    const r = await detectPullRequest(opts({ FAKE_GH_MODE: 'auth' }));
    assert.equal(r.ok, false);
    assert.match(!r.ok ? r.reason : '', /not logged in.*gh auth login/);
    assert.equal(postTargetOf(r).kind, 'none');
  });

  it('no PR for the branch, and no GitHub remote, each say so (the latter is not mistaken for a login problem)', async () => {
    const nopr = await detectPullRequest(opts({ FAKE_GH_MODE: 'nopr' }));
    assert.match(!nopr.ok ? nopr.reason : '', /no pull request for this branch/);
    const noremote = await detectPullRequest(opts({ FAKE_GH_MODE: 'noremote' }));
    assert.match(!noremote.ok ? noremote.reason : '', /no GitHub remote/);
    assert.doesNotMatch(!noremote.ok ? noremote.reason : '', /not logged in/);
  });

  it('gh not installed: says how to install or point filos.gh.path at it', async () => {
    const r = await detectPullRequest(opts({}, { gh: join(scratch, 'no-such-gh') }));
    assert.equal(r.ok, false);
    assert.match(!r.ok ? r.reason : '', /can't find the GitHub CLI.*filos\.gh\.path/);
  });

  it('an unreadable PR URL falls back to `gh repo view` for owner/repo', async () => {
    const r = await detectPullRequest(opts({ FAKE_GH_PR_URL: 'https://github.com/acme/ledger/pulls/42/files' }));
    assert.ok(r.ok);
    assert.equal(r.pr.owner, 'acme');
    assert.equal(r.pr.repo, 'ledger');
    assert.equal(r.pr.url, 'https://github.com/acme/ledger/pull/42');
    assert.deepEqual(
      calls().map((c) => c.argv.slice(0, 2)),
      [
        ['pr', 'view'],
        ['repo', 'view'],
      ],
    );
  });

  it('refuses a repo name that could steer the API path', async () => {
    const r = await detectPullRequest(opts({ FAKE_GH_PR_URL: 'https://github.com/acme/ledger/pull/42?x=1', FAKE_GH_REPO: 'acme/../../user' }));
    assert.equal(r.ok, false);
    assert.match(!r.ok ? r.reason : '', /couldn't be read/);
  });

  it('a GitHub Enterprise host is kept, and posted to with --hostname', async () => {
    const r = await detectPullRequest(opts({ FAKE_GH_HOST: 'github.acme.example' }));
    assert.ok(r.ok);
    assert.equal(r.pr.host, 'github.acme.example');
    const req = reviewRequest(r.pr, { body: 'x', comments: [] });
    assert.deepEqual(req.args, ['api', '--hostname', 'github.acme.example', '-X', 'POST', 'repos/acme/ledger/pulls/42/reviews', '--input', '-']);
  });
});

describe('parsing gh answers', () => {
  it('parsePullRequestUrl takes only plain https PR URLs', () => {
    assert.deepEqual(parsePullRequestUrl('https://github.com/acme/ledger/pull/42'), { host: 'github.com', owner: 'acme', repo: 'ledger', number: 42 });
    for (const bad of [
      'http://github.com/acme/ledger/pull/42',
      'https://github.com/acme/ledger/pull/42#x',
      'https://github.com/acme/ledger/pull/42?a=b',
      'https://u:p@github.com/acme/ledger/pull/42',
      'https://github.com/acme/ledger/issues/42',
      'https://github.com/acme/../pull/42',
      'https://github.com/ac%20me/ledger/pull/42',
      'not a url',
    ]) {
      assert.equal(parsePullRequestUrl(bad), undefined, bad);
    }
  });

  it('pullRequestFromView checks number, commit and base; a URL/number mismatch needs the fallback', () => {
    const view = { number: 42, url: PR.url, headRefOid: OID, baseRefName: 'main' };
    assert.deepEqual(pullRequestFromView(view), PR);
    assert.equal(pullRequestFromView({ ...view, number: 0 }), undefined);
    assert.equal(pullRequestFromView({ ...view, headRefOid: 'HEAD' }), undefined);
    assert.equal(pullRequestFromView({ ...view, baseRefName: '' }), undefined);
    assert.equal(pullRequestFromView({ ...view, number: 43 }), undefined);
    assert.equal(pullRequestFromView({ ...view, number: 43 }, { host: 'github.com', owner: 'acme', repo: 'ledger' })?.url, 'https://github.com/acme/ledger/pull/43');
    assert.equal(pullRequestFromView('nope'), undefined);
  });

  it('repoFromView takes owner/repo only when both parts are plain names', () => {
    assert.deepEqual(repoFromView({ nameWithOwner: 'acme/ledger', url: 'https://github.com/acme/ledger' }), { host: 'github.com', owner: 'acme', repo: 'ledger' });
    assert.equal(repoFromView({ nameWithOwner: 'acme/led/ger' }), undefined);
    assert.equal(repoFromView({ nameWithOwner: 'acme/..' }), undefined);
    assert.equal(repoFromView({ nameWithOwner: 'ac me/ledger' }), undefined);
  });
});

describe('postReview (fake gh)', () => {
  it('sends the review as JSON on stdin to `gh api -X POST repos/{owner}/{repo}/pulls/{n}/reviews --input -`', async () => {
    const plan = planPost(PR, [comment({ file: 'src/money/round.ts', line: 18, body: 'Keep half-up?', severity: 'blocking' })], sampleHeadLines(), { headOid: OID, base: 'main' });
    const res = await postReview(PR, plan.request, opts());
    assert.equal(res.url, 'https://github.com/acme/ledger/pull/42#pullrequestreview-1001');
    assert.equal(res.id, 1001);
    const c = calls();
    assert.equal(c.length, 1);
    assert.deepEqual(c[0].argv, ['api', '-X', 'POST', 'repos/acme/ledger/pulls/42/reviews', '--input', '-']);
    assert.deepEqual(JSON.parse(c[0].stdin ?? ''), {
      event: 'COMMENT',
      body: INLINE_ONLY_BODY,
      comments: [{ path: 'src/money/round.ts', line: 18, side: 'RIGHT', body: '**Blocking:** Keep half-up?' }],
      commit_id: OID,
    });
    // The payload never travels in argv.
    assert.ok(!c[0].argv.some((a) => a.includes('Keep half-up')));
  });

  it("an API error rejects with GitHub's own message, safe to show", async () => {
    const plan = planPost(PR, [comment({})], new Map(), { headOid: OID, base: 'main' });
    await assert.rejects(postReview(PR, plan.request, opts({ FAKE_GH_MODE: 'apierror' })), (e: unknown) => {
      assert.ok(e instanceof GhError);
      assert.equal(e.kind, 'api');
      assert.match(e.message, /HTTP 422 while posting the review: Unprocessable Entity: Line could not be resolved/);
      assert.doesNotMatch(e.message, /[[\]()`]/);
      return true;
    });
  });

  it('not logged in at post time is an auth error', async () => {
    const plan = planPost(PR, [comment({})], new Map(), { headOid: OID, base: 'main' });
    await assert.rejects(postReview(PR, plan.request, opts({ FAKE_GH_MODE: 'auth' })), (e: unknown) => e instanceof GhError && e.kind === 'auth');
  });

  it('a slow gh is killed at the timeout', async () => {
    const plan = planPost(PR, [comment({})], new Map(), { headOid: OID, base: 'main' });
    const t0 = Date.now();
    await assert.rejects(postReview(PR, plan.request, opts({ FAKE_GH_MODE: 'slow', FAKE_GH_DELAY_MS: '20000' }, { timeoutMs: 300 })), (e: unknown) => e instanceof GhError && e.kind === 'timeout');
    assert.ok(Date.now() - t0 < 5000);
  });
});

describe('planning a post', () => {
  const accepted = [
    comment({ id: 'c1', file: 'src/money/round.ts', line: 18, body: 'Inline on a changed line.', severity: 'blocking' }),
    comment({ id: 'c2', file: 'src/money/money.ts', line: 20, body: 'Line 20 is not in the diff.', severity: 'question' }),
    comment({ id: 'c3', body: 'No location.', severity: 'nit' }),
    comment({ id: 'c4', file: 'src/money/round.ts', line: 18, body: 'A draft is never posted.', status: 'draft' }),
  ];

  it('inline when the head line is in the diff, else in the body with its location; drafts never', () => {
    const plan = planPost(PR, accepted, sampleHeadLines(), { headOid: OID, base: 'origin/main' });
    assert.equal(plan.mismatch, undefined);
    assert.equal(plan.inline, 1);
    assert.equal(plan.general, 2);
    assert.deepEqual(plan.request.payload.comments, [{ path: 'src/money/round.ts', line: 18, side: 'RIGHT', body: '**Blocking:** Inline on a changed line.' }]);
    assert.equal(plan.request.payload.body, '` src/money/money.ts:20 `: **Question:** Line 20 is not in the diff.\n\n**Nit:** No location.');
    assert.equal(plan.request.payload.commit_id, OID);
    assert.ok(!JSON.stringify(plan.request.payload).includes('A draft'));
  });

  it("a checkout that isn't the PR's head (or a different base) puts every comment in the body", () => {
    const moved = planPost(PR, accepted, sampleHeadLines(), { headOid: OTHER_OID, base: 'main' });
    assert.match(moved.mismatch ?? '', /bbbbbbb.*aaaaaaa/);
    assert.equal(moved.inline, 0);
    assert.equal(moved.general, 3);
    assert.deepEqual(moved.request.payload.comments, []);
    assert.match(moved.request.payload.body, /` src\/money\/round\.ts:18 `: \*\*Blocking:\*\* Inline on a changed line\./);
    assert.match(inlineMismatch(PR, { headOid: OID, base: 'develop' }) ?? '', /reviewed against develop.*targets main/);
    assert.equal(inlineMismatch(PR, { headOid: OID, base: 'refs/remotes/origin/main' }), undefined);
    assert.match(inlineMismatch(PR, { base: 'main' }) ?? '', /unknown/);
  });

  it('the confirmation names repo#number, the counts and that the review is public', () => {
    const plan = planPost(PR, accepted, sampleHeadLines(), { headOid: OID, base: 'main' });
    const t = confirmationText(PR, plan);
    assert.equal(t.message, 'Post your review to acme/ledger#42?');
    assert.match(t.detail, /^1 comment inline on changed lines and 2 comments in the review body\./);
    assert.match(t.detail, /public/);
    const moved = confirmationText(PR, planPost(PR, accepted.slice(0, 1), sampleHeadLines(), { headOid: OTHER_OID, base: 'main' }));
    assert.match(moved.detail, /^1 comment in the review body\.\n\nYour checkout .* Every comment goes in the review body/);
  });

  it('refuses to build a request for PR details that fail the checks', () => {
    assert.throws(() => reviewRequest({ ...PR, owner: 'ac/me' }, { body: '', comments: [] }), GhError);
    assert.throws(() => reviewRequest({ ...PR, headRefOid: 'HEAD' }, { body: '', comments: [] }), GhError);
    assert.throws(() => reviewRequest({ ...PR, number: 1.5 }, { body: '', comments: [] }), GhError);
  });
});

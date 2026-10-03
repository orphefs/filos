// The host side of a review (src/host/reviewState.ts) with a stubbed vscode, a fake agent provider
// and the fake gh (test/fixtures/fake-gh): what a post sends and where, what a failed or cancelled
// call leaves behind, and what two reviews of the same PR do to each other's stored state.
// Nothing here talks to GitHub or runs a real agent.

import './vscodeStub';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { after, beforeEach, describe, it } from 'node:test';
import { ProviderError, type AgentProvider, type AskRequest, type ProviderConfig } from '../../src/agent';
import type { ReviewGraph } from '../../src/contract/graph';
import { detectPullRequest } from '../../src/host/github';
import { ReviewState, type ReviewHost } from '../../src/host/reviewState';
import { ReviewSession } from '../../src/host/session';
import { parsePersistedReview } from '../../src/review/model';
import { answerFor } from '../../src/review/types';
import { MemoryMemento, shown } from './vscodeStub';

const ROOT = resolve(__dirname, '../..');
const FIXTURES = join(ROOT, 'fixtures');
const FAKE_GH = join(ROOT, 'test/fixtures/fake-gh/gh');
const REVIEWED = 'a'.repeat(40);
const MOVED = 'b'.repeat(40);

const scratch = mkdtempSync(join(tmpdir(), 'filos-review-state-'));
const REPO = join(scratch, 'repo');
cpSync(join(FIXTURES, 'sample-repo/head'), REPO, { recursive: true });
const RECORD = join(scratch, 'gh-calls.jsonl');

const ENV_KEYS = ['FAKE_GH_RECORD', 'FAKE_GH_MODE', 'FAKE_GH_HEAD_OID', 'FAKE_GH_HEAD_REF', 'FAKE_GH_STATE', 'FAKE_GH_PR_NUMBER'] as const;
const savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
after(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  rmSync(scratch, { recursive: true, force: true });
});

beforeEach(() => {
  rmSync(RECORD, { force: true });
  shown.length = 0;
  Object.assign(process.env, { FAKE_GH_RECORD: RECORD, FAKE_GH_MODE: 'ok', FAKE_GH_HEAD_OID: REVIEWED, FAKE_GH_HEAD_REF: 'feature-x' });
  delete process.env.FAKE_GH_STATE;
  delete process.env.FAKE_GH_PR_NUMBER;
});

const graph = (): ReviewGraph => JSON.parse(readFileSync(join(FIXTURES, 'sample-graph.json'), 'utf8')) as ReviewGraph;
const sampleQuestions = (): unknown => JSON.parse(readFileSync(join(FIXTURES, 'sample-questions.json'), 'utf8'));

/** The sample PR's diff, with repo-relative paths (git diff --no-index prefixes base/ and head/). */
const SAMPLE_DIFF = (() => {
  const out = spawnSync('git', ['diff', '--no-index', '--no-ext-diff', '--no-color', '--src-prefix=a/', '--dst-prefix=b/', 'base', 'head'], { cwd: join(FIXTURES, 'sample-repo'), encoding: 'utf8' });
  return out.stdout.replace(/([ab])\/(?:base|head)\//g, '$1/');
})();

interface GhCall {
  argv: string[];
  stdin?: string;
}
const calls = (): GhCall[] => (existsSync(RECORD) ? readFileSync(RECORD, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as GhCall) : []);
const apiCalls = () => calls().filter((c) => c.argv[0] === 'api');
const payloadOf = (c: GhCall) => JSON.parse(c.stdin ?? '{}') as { body: string; commit_id: string; comments: { path: string; line: number; body: string }[] };

const CONFIG: ProviderConfig = { id: 'claude', claudePath: 'fake', maxBudgetUsd: 0.1, timeoutSeconds: 30 };
const silentLog = { info() {}, warn() {}, error() {}, debug() {}, trace() {} } as unknown as ReviewHost['log'];

interface Opened {
  state: ReviewState;
  session: ReviewSession;
  confirmations: { message: string; detail: string }[];
  asks: string[];
}

interface OpenOptions {
  /** Answers the posting modal (default: "Post review"). Runs while the post waits on it. */
  confirm?: (state: ReviewState) => Promise<boolean> | boolean;
  /** The agent's raw answer to an `evaluate` task. */
  evaluate?: (req: AskRequest<unknown>) => Promise<unknown>;
}

/** A branch review of the sample PR at REVIEWED, as the controller opens one, with its PR looked up. */
async function openReview(store: MemoryMemento, o: OpenOptions = {}): Promise<Opened> {
  const session = new ReviewSession({ kind: 'branch', repoRoot: REPO, base: 'main', head: 'feature-x', prTitle: 'Round half-even' }, store as never, 'test-repo');
  session.diff = SAMPLE_DIFF;
  session.headOid = REVIEWED;
  session.pullRequest = detectPullRequest({ gh: FAKE_GH, cwd: REPO });
  const asks: string[] = [];
  const confirmations: Opened['confirmations'] = [];
  const provider: AgentProvider = {
    id: 'fake',
    displayName: 'Fake agent',
    loginCommand: 'fake login',
    login: { command: 'fake', args: ['login'] },
    checkReady: async () => {},
    comprehend: () => Promise.reject(new Error('not used here')),
    async ask<T>(req: AskRequest<T>) {
      asks.push(req.task);
      const raw = req.task === 'questions' ? sampleQuestions() : req.task === 'evaluate' && o.evaluate ? await o.evaluate(req as AskRequest<unknown>) : { verdict: 'correct', reply: 'Right.' };
      const v = req.validate(raw);
      if (!v.ok) throw new ProviderError('contract', v.errors.join('\n'));
      return { value: v.value, warnings: v.warnings };
    },
  };
  let state: ReviewState | undefined;
  const host: ReviewHost = {
    log: silentLog,
    globalState: new MemoryMemento() as never,
    extensionPath: ROOT,
    send() {},
    provider: () => ({ provider, config: CONFIG }),
    openLogin() {},
    ghPath: () => FAKE_GH,
    async confirm(message, detail) {
      confirmations.push({ message, detail });
      return o.confirm && state ? o.confirm(state) : true;
    },
    besideColumn: () => 2 as never,
  };
  const opened = new ReviewState(host, session, graph(), 'agent');
  state = opened;
  opened.start();
  await opened.idle();
  await session.pullRequest;
  await opened.idle();
  assert.equal(opened.model.snapshot().questionsStatus.state, 'ready');
  return { state: opened, session, confirmations, asks };
}

/** Picks "keep half-up" (a blocking comment on src/money/round.ts:18, a changed line) and accepts it. */
async function acceptRoundComment(state: ReviewState): Promise<string> {
  await state.apply({ type: 'answer', questionId: 'q-round-default', choiceId: 'keep-half-up' });
  const c = state.model.snapshot().comments.find((x) => x.origin.kind === 'question')!;
  assert.deepEqual([c.file, c.line, c.commit], ['src/money/round.ts', 18, REVIEWED]);
  await state.apply({ type: 'commentAction', id: c.id, action: 'accept' });
  return c.id;
}

const storedReview = (o: Opened, store: MemoryMemento) => parsePersistedReview(store.get(`filos.review:${o.session.key}`));

async function until(check: () => boolean, what: string, ms = 5000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) assert.fail(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe('ReviewState: posting', () => {
  it('posts against the commit reviewed: inline when the PR head is that commit', async () => {
    const r = await openReview(new MemoryMemento());
    const id = await acceptRoundComment(r.state);
    await r.state.apply({ type: 'post' });
    const s = r.state.model.snapshot();
    assert.equal(s.post.status, 'posted', s.post.error);
    assert.deepEqual(r.confirmations, [
      {
        message: 'Post your review to acme/ledger#42?',
        detail: '1 comment inline on changed lines.\n\nThe review is public: anyone who can see the pull request can read it, and GitHub notifies its author. It is posted as you, through the GitHub CLI.',
      },
    ]);
    const views = calls().filter((c) => c.argv[0] === 'pr');
    assert.deepEqual(views.map((c) => c.argv[2]), ['--json', 'https://github.com/acme/ledger/pull/42'], 'at post time, the PR the panel names, by URL');
    const [api] = apiCalls();
    assert.equal(payloadOf(api).commit_id, REVIEWED);
    assert.deepEqual(payloadOf(api).comments.map((c) => [c.path, c.line]), [['src/money/round.ts', 18]]);
    assert.ok(r.state.model.isPosted(id));
  });

  it('the PR moved on since the review: nothing goes inline, and the modal leads with it', async () => {
    const r = await openReview(new MemoryMemento());
    await acceptRoundComment(r.state);
    // The author pushed; the reviewer may have pulled too. Line 18 of the new head is another line.
    process.env.FAKE_GH_HEAD_OID = MOVED;
    await r.state.apply({ type: 'post' });
    assert.equal(r.state.model.snapshot().post.status, 'posted');
    const [modal] = r.confirmations;
    assert.equal(modal.message, 'Post your review to acme/ledger#42 anyway?');
    assert.match(modal.detail, /^The commit you reviewed \(aaaaaaa\) isn't the pull request's head \(bbbbbbb\)/);
    const p = payloadOf(apiCalls()[0]);
    assert.deepEqual(p.comments, []);
    assert.match(p.body, /^` src\/money\/round\.ts:18 `: \*\*Blocking:\*\*/);
  });

  it('posts to the PR the panel names, even after a checkout of a branch with another PR', async () => {
    const r = await openReview(new MemoryMemento());
    const target = r.state.model.snapshot().post.target;
    assert.equal(target.kind === 'github' ? target.number : undefined, 42);
    await acceptRoundComment(r.state);
    process.env.FAKE_GH_PR_NUMBER = '43'; // what `gh pr view` without a URL would answer now
    await r.state.apply({ type: 'post' });
    assert.equal(r.state.model.snapshot().post.status, 'posted');
    assert.match(apiCalls()[0].argv.join(' '), /repos\/acme\/ledger\/pulls\/42\/reviews/);
  });

  it('a merged PR is no target; one merged after the review started is refused at post time', async () => {
    process.env.FAKE_GH_STATE = 'MERGED';
    const merged = await openReview(new MemoryMemento());
    const t = merged.state.model.snapshot().post.target;
    assert.equal(t.kind, 'none');
    assert.match(t.kind === 'none' ? t.reason : '', /acme\/ledger#42\) is merged, so Filos won't post to it/);
    await acceptRoundComment(merged.state);
    await merged.state.apply({ type: 'post' });
    assert.equal(merged.confirmations.length, 0);

    delete process.env.FAKE_GH_STATE;
    const r = await openReview(new MemoryMemento());
    await acceptRoundComment(r.state);
    process.env.FAKE_GH_STATE = 'CLOSED';
    await r.state.apply({ type: 'post' });
    const s = r.state.model.snapshot();
    assert.equal(s.post.status, 'error');
    assert.match(s.post.error ?? '', /is closed, so Filos won't post to it/);
    assert.equal(r.confirmations.length, 0);
    assert.equal(apiCalls().length, 0);
  });

  it('comments rejected or amended while the post is pending stay as confirmed: what is sent is what is marked', async () => {
    const r = await openReview(new MemoryMemento(), {
      async confirm(state) {
        // The cards are live while the modal is up; the host refuses changes to what is being posted.
        await state.apply({ type: 'commentAction', id: 'c1', action: 'reject' });
        await state.apply({ type: 'amend', id: 'c2', body: 'Toned down, no mentions.' });
        return true;
      },
    });
    await acceptRoundComment(r.state);
    await r.state.apply({ type: 'addNote', text: 'Please @someone look at this.' });
    await r.state.apply({ type: 'commentAction', id: 'c2', action: 'accept' });
    await r.state.apply({ type: 'post' });
    const s = r.state.model.snapshot();
    assert.deepEqual(
      s.comments.map((c) => [c.id, c.status, c.body, c.posted]),
      [
        ['c1', 'accepted', s.comments[0].body, true],
        ['c2', 'accepted', 'Please @someone look at this.', true],
      ],
    );
    const p = payloadOf(apiCalls()[0]);
    assert.equal(p.body, '**Suggestion:** Please @someone look at this.');
    assert.equal(p.comments.length, 1);
  });

  it('a post that may have reached GitHub is flagged: the error says so, and the next modal warns first', async () => {
    const store = new MemoryMemento();
    const r = await openReview(store);
    const id = await acceptRoundComment(r.state);
    process.env.FAKE_GH_MODE = 'api502';
    await r.state.apply({ type: 'post' });
    let s = r.state.model.snapshot();
    assert.equal(s.post.status, 'error');
    assert.match(s.post.error ?? '', /HTTP 502 .* The review may still have reached GitHub: check the pull request before posting again\./);
    assert.ok(r.state.model.mayBePosted(id));
    assert.deepEqual(storedReview(r, store)?.maybePosted, [id], 'kept across a reload');

    process.env.FAKE_GH_MODE = 'ok';
    await r.state.apply({ type: 'post' });
    s = r.state.model.snapshot();
    assert.equal(s.post.status, 'posted');
    const second = r.confirmations[1];
    assert.equal(second.message, 'Post your review to acme/ledger#42 anyway?');
    assert.match(second.detail, /^An earlier attempt to post 1 of these comments ended without a clear answer from GitHub/);
    const stored = storedReview(r, store)!;
    assert.deepEqual([stored.posted, stored.maybePosted], [[id], undefined]);
  });

  it('a second review of the PR does not post again what the first posted after it opened', async () => {
    const store = new MemoryMemento();
    const a = await openReview(store);
    const id = await acceptRoundComment(a.state);
    const b = await openReview(store); // loads c1 as accepted, not posted
    await a.state.apply({ type: 'post' });
    assert.equal(apiCalls().length, 1);
    await b.state.apply({ type: 'addNote', text: 'A later thought.' });
    assert.deepEqual(storedReview(b, store)?.posted, [id], "b's save keeps a's posted mark");
    await b.state.apply({ type: 'post' });
    assert.equal(apiCalls().length, 1, 'nothing posted twice');
    assert.ok(b.state.model.isPosted(id));
    assert.ok(shown.some((m) => m.text === 'Filos: every accepted comment is already posted.'));
  });
});

describe('ReviewState: closing while the agent grades', () => {
  it('leaves the answer unanswered (no reference shown, nothing done), and never overwrites a newer review', async () => {
    const store = new MemoryMemento();
    // The CLI takes a moment to stop after the abort, as a real one does.
    const slowCancel = (req: AskRequest<unknown>) =>
      new Promise((_, reject) => req.signal?.addEventListener('abort', () => setTimeout(() => reject(new ProviderError('cancelled', 'cancelled')), 50)));
    const a = await openReview(store, { evaluate: slowCancel });
    await a.state.apply({ type: 'answer', questionId: 'q-round-default', choiceId: 'keep-half-up' });
    const grading = a.state.apply({ type: 'answer', questionId: 'q-checkout-web', text: 'Totals move by a cent.' });
    assert.equal(answerFor(a.state.model.snapshot().answers, 'q-checkout-web')?.pending, true);
    a.state.dispose(); // the panel closed, or the review was re-run

    // The review opened next answers something before the old one's grading has stopped.
    const b = await openReview(store);
    await b.state.apply({ type: 'answer', questionId: 'q-multiply-ties', choiceId: 'a' });
    await grading;
    await until(() => !a.state.model.snapshot().answers['q-checkout-web'], 'the cancelled grading to settle');

    const stored = storedReview(b, store)!;
    assert.equal(answerFor(stored.answers, 'q-checkout-web'), undefined, 'not stored as a self-check or as done');
    assert.ok(answerFor(stored.answers, 'q-multiply-ties'), "the newer review's answer survives the old one's late write");
    assert.ok(!shown.some((m) => m.kind === 'warning'), 'a cancel is not reported as a failure');

    // Reopened, the question is asked and graded again.
    const c = await openReview(store);
    await c.state.apply({ type: 'answer', questionId: 'q-checkout-web', text: 'Totals move by a cent.' });
    assert.ok(c.asks.includes('evaluate'));
    assert.equal(answerFor(c.state.model.snapshot().answers, 'q-checkout-web')?.attempts[0].verdict, 'correct');
  });
});

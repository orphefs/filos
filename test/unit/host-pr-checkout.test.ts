// Getting a pull request's code: Filos's own blobless clone (made through the fake gh's `repo clone`
// from a local bare repo with refs/pull/9/head, as GitHub has), a fetch into Filos's own refs, a
// detached worktree per head, and the diff. Also: hooks never run, a moved PR is noticed, worktrees
// are reused or replaced, concurrent prepares share one clone, and cancellation stops git.

import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { chmodSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { LOCK_FILE } from '../../src/host/checkoutLocks';
import * as git from '../../src/host/git';
import {
  checkoutPaths,
  checkoutsIdle,
  checkoutUsage,
  deleteCheckouts,
  dependencyIndexAt,
  ensureStorage,
  originMatches,
  prepareCheckout,
  PrError,
  pullRequestDetailsFromView,
  pullRequestDiff,
  worktreeName,
  type CheckoutOptions,
  type PullRequestDetails,
} from '../../src/host/pr';
import { readDependencyIndex } from '../../src/host/depIndex';
import { hookTemplate, makeRemote, PR_HEAD_BRANCH, pushToPullRequest, sh, type FakeRemote } from '../fixtures/fake-gh/makeRemote';

const FAKE_GH = resolve(__dirname, '../fixtures/fake-gh/gh');

const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'filos-pr-checkout-')));
after(() => rmSync(scratch, { recursive: true, force: true }));

const RECORD = join(scratch, 'gh-calls.jsonl');
const MARKER = join(scratch, 'hooks-ran.txt');

let fake: FakeRemote;
let root: string;

function details(over: Record<string, unknown> = {}): PullRequestDetails {
  const r = pullRequestDetailsFromView({ ...fake.pr, ...over });
  assert.ok(r.ok, r.ok ? '' : r.problems.join('; '));
  return r.pr;
}

/** No user or system git config (a developer's global hooks or insteadOf can't leak in); hooks from the template. */
function options(over: Partial<CheckoutOptions> = {}, env: Record<string, string> = {}): CheckoutOptions {
  return {
    gh: FAKE_GH,
    root,
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_TEMPLATE_DIR: join(scratch, 'template'),
      FAKE_GH_REMOTE: fake.remote,
      FAKE_GH_RECORD: RECORD,
      FAKE_GH_MODE: 'ok',
      ...env,
    },
    ...over,
  };
}

interface GhCall {
  argv: string[];
  cwd: string;
  ghHost?: string;
}

function ghCalls(): GhCall[] {
  if (!existsSync(RECORD)) return [];
  return readFileSync(RECORD, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as GhCall);
}

/** Another process that stays alive until killed: stands in for another VS Code window's extension host. */
function otherWindow(): ChildProcess & { pid: number } {
  const p = spawn('sleep', ['120'], { stdio: 'ignore' });
  assert.ok(p.pid);
  return p as ChildProcess & { pid: number };
}

/** What another window writes for a lock or a lease it holds (checkoutLocks.ts). */
const ownerOf = (pid: number) => JSON.stringify({ pid, host: hostname(), token: 'f'.repeat(16) });

const until = async (what: string, ok: () => boolean, ms = 5000) => {
  const end = Date.now() + ms;
  while (!ok()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
};

before(() => {
  fake = makeRemote(join(scratch, 'github'));
  hookTemplate(join(scratch, 'template'), MARKER);
  root = join(scratch, 'storage', 'prs');
});

describe('prepareCheckout', () => {
  it('clones once through gh, fetches the PR into its own refs and checks the head out in a worktree', async () => {
    const pr = details();
    const steps: string[] = [];
    const c = await prepareCheckout(pr, options({ onProgress: (stage, text) => steps.push(`${stage}: ${text}`) }));
    assert.equal(c.cloned, true);
    assert.equal(c.reusedWorktree, false);
    assert.deepEqual(steps, ['clone: cloning acme/ledger', 'fetch: fetching #9', `checkout: checking out ${fake.headOid.slice(0, 7)}`]);
    assert.equal(c.headOid, fake.headOid);
    assert.equal(c.baseOid, fake.baseOid);
    assert.equal(c.mergeBase, fake.baseOid);
    assert.deepEqual(c.warnings, []);

    const paths = checkoutPaths(root, pr);
    assert.equal(c.repoDir, paths.repoDir);
    assert.equal(c.worktree, realpathSync(join(paths.worktrees, worktreeName(9, fake.headOid))));
    // The clone was made by gh, blobless, with no checkout of its own, and hooks and symlinks off in its config.
    const clone = ghCalls().find((x) => x.argv[0] === 'repo' && x.argv[1] === 'clone');
    assert.ok(clone);
    // host/owner/repo, with GH_HOST set to that host: never wherever a GH_HOST in the environment points.
    assert.equal(clone.argv[2], 'github.com/acme/ledger');
    assert.equal(clone.ghHost, 'github.com');
    assert.equal(sh(c.repoDir, ['config', '--get', 'remote.origin.url']).trim(), 'https://github.com/acme/ledger.git');
    assert.deepEqual(clone.argv.slice(clone.argv.indexOf('--') + 1, clone.argv.indexOf('--') + 3), ['--filter=blob:none', '--no-checkout']);
    assert.equal(sh(c.repoDir, ['config', '--get', 'remote.origin.partialclonefilter']).trim(), 'blob:none');
    assert.equal(sh(c.repoDir, ['config', '--get', 'core.hooksPath']).trim(), '/dev/null');
    assert.equal(sh(c.repoDir, ['config', '--get', 'core.symlinks']).trim(), 'false');
    assert.deepEqual(readdirSync(c.repoDir), ['.git'], 'the clone itself has no checkout');
    assert.equal(sh(c.repoDir, ['rev-parse', 'refs/filos/pr/9/head']).trim(), fake.headOid);
    assert.equal(sh(c.repoDir, ['rev-parse', 'refs/filos/pr/9/base']).trim(), fake.baseOid);

    // The worktree is the head revision, detached.
    assert.equal(sh(c.worktree, ['rev-parse', 'HEAD']).trim(), fake.headOid);
    assert.equal(sh(c.worktree, ['rev-parse', '--abbrev-ref', 'HEAD']).trim(), 'HEAD', 'detached');
    assert.equal(readFileSync(join(c.worktree, 'src/money/round.ts'), 'utf8'), readFileSync(resolve(__dirname, '../../fixtures/sample-repo/head/src/money/round.ts'), 'utf8'));
    assert.ok(readDependencyIndex(c.worktree).text, "the head's dependency index is readable from the worktree");
    // ...but the review's index is the merge base's, and the sample's base has none.
    assert.deepEqual(c.dependencyIndex, {});
    assert.ok(!existsSync(MARKER), `no hook ran: ${existsSync(MARKER) ? readFileSync(MARKER, 'utf8') : ''}`);
  });

  it("diffs merge base to head exactly like the full repository's base...head", async () => {
    const pr = details();
    const c = await prepareCheckout(pr, options());
    const diff = await pullRequestDiff(pr, c);
    const full = await git.diff(fake.remote, 'main', `refs/pull/${fake.number}/head`, { env: { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } });
    assert.ok(diff.length > 1000);
    assert.equal(diff, full);
    assert.match(diff, /^diff --git a\/src\/invoice\/discount\.ts b\/src\/invoice\/discount\.ts$/m);
  });

  it('reuses a clean worktree at the same head, and makes it again when it was edited', async () => {
    const pr = details();
    const first = await prepareCheckout(pr, options());
    const again = await prepareCheckout(pr, options());
    assert.equal(again.cloned, false);
    assert.equal(again.reusedWorktree, true);
    assert.equal(again.worktree, first.worktree);
    assert.equal(ghCalls().filter((x) => x.argv[1] === 'clone').length, 1, 'cloned only once');

    writeFileSync(join(first.worktree, 'src/money/round.ts'), '// edited by hand\n');
    const remade = await prepareCheckout(pr, options());
    assert.equal(remade.reusedWorktree, false);
    assert.equal(readFileSync(join(remade.worktree, 'src/money/round.ts'), 'utf8'), readFileSync(resolve(__dirname, '../../fixtures/sample-repo/head/src/money/round.ts'), 'utf8'));
  });

  it("notices a pull request that moved, and replaces the old head's worktree", async () => {
    const pr = details(); // GitHub still says the old head
    const old = await prepareCheckout(pr, options());
    const moved = pushToPullRequest(fake, 'src/money/round.ts', '// a later commit\nexport const x = 1;\n');
    try {
      const c = await prepareCheckout(pr, options());
      assert.equal(c.headOid, moved);
      assert.equal(c.warnings.length, 1);
      assert.match(c.warnings[0], new RegExp(`GitHub said its head was ${fake.headOid.slice(0, 7)}, and the fetch brought ${moved.slice(0, 7)}`));
      assert.notEqual(c.worktree, old.worktree);
      assert.ok(!existsSync(old.worktree), 'the older worktree of the same PR is gone');
      assert.ok(!sh(c.repoDir, ['worktree', 'list', '--porcelain']).includes(old.worktree), 'and unregistered');
      assert.equal(readFileSync(join(c.worktree, 'src/money/round.ts'), 'utf8'), '// a later commit\nexport const x = 1;\n');
    } finally {
      // Put the PR back for the other tests.
      sh(fake.remote, ['update-ref', `refs/pull/${fake.number}/head`, fake.headOid]);
    }
  });

  it('never runs hooks: not from the clone template, nor when the clone config no longer disables them', async () => {
    const pr = details();
    const c = await prepareCheckout(pr, options());
    // The template's hooks were copied into the clone, ready to run, if git ever looked for them there.
    assert.ok(existsSync(join(c.repoDir, '.git', 'hooks', 'post-checkout')));
    // Even with the clone's own setting gone, every call Filos makes passes core.hooksPath itself.
    sh(c.repoDir, ['config', '--unset', 'core.hooksPath']);
    const moved = pushToPullRequest(fake, 'README.md', '# moved again\n');
    try {
      const again = await prepareCheckout({ ...pr, headRefOid: moved }, options());
      assert.equal(again.headOid, moved);
      await pullRequestDiff(pr, again);
    } finally {
      sh(fake.remote, ['update-ref', `refs/pull/${fake.number}/head`, fake.headOid]);
    }
    assert.ok(!existsSync(MARKER), `a hook ran: ${existsSync(MARKER) ? readFileSync(MARKER, 'utf8') : ''}`);
  });

  it('checks symlinks out as plain files, so nothing leads out of the checkout', async () => {
    const pr = details();
    const work = mkdtempSync(join(scratch, 'link-'));
    sh(work, ['init', '--quiet']);
    sh(work, ['fetch', '--quiet', fake.remote, `refs/pull/${fake.number}/head:refs/heads/pr`]);
    sh(work, ['checkout', '--quiet', 'pr']);
    sh(work, ['config', 'core.symlinks', 'true']);
    const { symlinkSync } = await import('node:fs');
    symlinkSync('/etc/passwd', join(work, 'secrets'));
    sh(work, ['add', 'secrets']);
    sh(work, ['commit', '--quiet', '--no-verify', '-m', 'link']);
    const oid = sh(work, ['rev-parse', 'HEAD']).trim();
    sh(work, ['push', '--quiet', '--force', fake.remote, `HEAD:refs/pull/${fake.number}/head`]);
    try {
      const c = await prepareCheckout({ ...pr, headRefOid: oid }, options());
      const st = lstatSync(join(c.worktree, 'secrets'));
      assert.ok(st.isFile() && !st.isSymbolicLink());
      assert.equal(readFileSync(join(c.worktree, 'secrets'), 'utf8'), '/etc/passwd');
    } finally {
      sh(fake.remote, ['update-ref', `refs/pull/${fake.number}/head`, fake.headOid]);
    }
  });

  it('runs one prepare at a time per repository, sharing one clone', async () => {
    const other = join(scratch, 'storage-concurrent');
    const pr = details();
    const both = await Promise.all([prepareCheckout(pr, options({ root: other })), prepareCheckout(pr, options({ root: other }))]);
    assert.deepEqual(
      both.map((c) => c.cloned),
      [true, false],
    );
    assert.equal(both[0].worktree, both[1].worktree);
    await checkoutsIdle(other);
    const usage = await checkoutUsage(other);
    assert.deepEqual(usage.repos, ['github.com/acme/ledger']);
    assert.ok(usage.bytes > 10_000);
  });

  it('a failed or cancelled clone leaves nothing that looks reusable', async () => {
    const other = join(scratch, 'storage-fail');
    const pr = details();
    await assert.rejects(prepareCheckout(pr, options({ root: other }, { FAKE_GH_MODE: 'clonefail' })), (e: unknown) => e instanceof PrError && e.kind === 'noAccess');
    assert.ok(!existsSync(checkoutPaths(other, pr).repoDir));
    assert.deepEqual(readdirSync(checkoutPaths(other, pr).base), [], 'no scratch clone left behind');
    const abort = new AbortController();
    abort.abort();
    await assert.rejects(prepareCheckout(pr, options({ root: other, signal: abort.signal })), (e: unknown) => e instanceof PrError && e.kind === 'cancelled');
    await assert.rejects(prepareCheckout(pr, options({ root: other }, { FAKE_GH_MODE: 'auth' })), (e: unknown) => e instanceof PrError && e.kind === 'ghAuth');
    // After all that, a good run still works from scratch.
    const c = await prepareCheckout(pr, options({ root: other }));
    assert.equal(c.cloned, true);
  });

  it('says so when the base branch is gone, and when the PR has no head ref', async () => {
    const pr = details();
    await assert.rejects(prepareCheckout({ ...pr, baseRefName: 'release/gone' }, options()), (e: unknown) => {
      assert.ok(e instanceof PrError, String(e));
      assert.equal(e.kind, 'notFound');
      assert.match(e.message, /base branch, release\/gone, no longer exists/);
      return true;
    });
    await assert.rejects(prepareCheckout({ ...pr, number: 77 }, options()), (e: unknown) => e instanceof PrError && e.kind === 'notFound' && /no commits for acme\/ledger#77/.test(e.message));
  });

  it('never touches anything outside its storage', async () => {
    mkdirSync(root, { recursive: true });
    const before = readdirSync(join(scratch, 'github')).sort();
    await prepareCheckout(details(), options());
    assert.deepEqual(readdirSync(join(scratch, 'github')).sort(), before, 'the "GitHub" side is unchanged');
    for (const call of ghCalls().filter((x) => x.argv[1] === 'clone')) assert.ok(call.cwd.startsWith(join(scratch, 'storage')), call.cwd);
  });
});

describe('git calls in these clones', () => {
  it('stop at their timeout or when cancelled, and say which', async () => {
    const dir = mkdtempSync(join(scratch, 'slow-'));
    // `git -c alias.wait=!sleep 5 wait` runs a shell alias: a stand-in for a slow network call.
    const slow = ['-c', 'alias.wait=!sleep 5'];
    await assert.rejects(git.git(dir, ['wait'], { config: slow, timeoutMs: 200 }), (e: unknown) => e instanceof git.GitError && e.code === git.TIMED_OUT && /didn't finish within 0 seconds/.test(e.message));
    const abort = new AbortController();
    setTimeout(() => abort.abort(), 100);
    await assert.rejects(git.git(dir, ['wait'], { config: slow, signal: abort.signal }), (e: unknown) => e instanceof git.GitError && e.code === git.ABORTED);
    await assert.rejects(git.git(dir, ['status'], { signal: AbortSignal.abort() }), (e: unknown) => e instanceof git.GitError && e.code === git.ABORTED);
  });
});

describe('GH_HOST in the environment (finding: github.com clones went to another server)', () => {
  it('a github.com PR is cloned from github.com, whatever GH_HOST says', async () => {
    const other = join(scratch, 'storage-ghhost');
    const c = await prepareCheckout(details(), options({ root: other }, { GH_HOST: 'ghe.corp.example', GH_REPO: 'mirror/ledger' }));
    assert.equal(c.cloned, true);
    const clone = ghCalls().filter((x) => x.argv[1] === 'clone').pop()!;
    assert.equal(clone.argv[2], 'github.com/acme/ledger');
    assert.equal(clone.ghHost, 'github.com');
    assert.equal(sh(c.repoDir, ['config', '--get', 'remote.origin.url']).trim(), 'https://github.com/acme/ledger.git');
  });

  it("an earlier clone from another server is replaced, never fetched into, and the review says so", async () => {
    const other = join(scratch, 'storage-wrong-origin');
    const pr = details();
    const first = await prepareCheckout(pr, options({ root: other }));
    // What `gh repo clone acme/ledger` made with GH_HOST=ghe.corp.example in the environment.
    sh(first.repoDir, ['config', 'remote.origin.url', 'https://ghe.corp.example/acme/ledger.git']);
    const again = await prepareCheckout(pr, options({ root: other }));
    assert.equal(again.cloned, true);
    assert.equal(sh(again.repoDir, ['config', '--get', 'remote.origin.url']).trim(), 'https://github.com/acme/ledger.git');
    assert.ok(again.warnings.some((w) => /came from ghe\.corp\.example\/acme\/ledger, not github\.com, so it was cloned again/.test(w)), again.warnings.join('\n'));
    assert.equal(again.headOid, fake.headOid);
  });

  it('originMatches takes https, ssh and scp-like remotes of the same repository, on the same host', () => {
    const pr = { host: 'github.com', owner: 'Acme', repo: 'Ledger' };
    for (const ok of ['https://github.com/acme/ledger.git', 'https://github.com/Acme/Ledger', 'git@github.com:acme/ledger.git', 'ssh://git@github.com/acme/ledger.git', 'https://user@github.com/acme/ledger.git/']) assert.ok(originMatches(ok, pr), ok);
    for (const no of ['https://ghe.corp.example/acme/ledger.git', 'https://github.com/acme/other.git', 'https://github.com/mirror/ledger.git', 'file:///tmp/remote.git', '']) assert.ok(!originMatches(no, pr), no);
    assert.ok(originMatches('https://ghe.example:8443/a/b.git', { host: 'ghe.example:8443', owner: 'a', repo: 'b' }));
  });
});

describe("closed and merged pull requests (finding: compared with the base branch's current tip)", () => {
  /** Merges the PR into main as GitHub's "Create a merge commit" does; returns the merge commit. */
  function mergeIntoMain(): string {
    const work = mkdtempSync(join(scratch, 'merge-'));
    sh(work, ['init', '--quiet']);
    sh(work, ['fetch', '--quiet', fake.remote, 'refs/heads/main:refs/heads/main', `refs/pull/${fake.number}/head:refs/heads/pr`]);
    sh(work, ['checkout', '--quiet', 'main']);
    sh(work, ['merge', '--quiet', '--no-ff', '--no-verify', '-m', `Merge pull request #${fake.number}`, 'pr']);
    sh(work, ['push', '--quiet', fake.remote, 'main:refs/heads/main']);
    return sh(work, ['rev-parse', 'HEAD']).trim();
  }
  let merge: string;
  let expected: string;
  before(async () => {
    expected = await git.diff(fake.remote, 'main', `refs/pull/${fake.number}/head`, { env: { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } });
    merge = mergeIntoMain();
  });
  after(() => sh(fake.remote, ['update-ref', 'refs/heads/main', fake.baseOid]));

  it('merged with a merge commit, gh without baseRefOid: the diff is the PR, from the merge commit\'s first parent', async () => {
    const pr = details({ state: 'MERGED', baseRefOid: undefined, mergeCommit: { oid: merge } });
    const c = await prepareCheckout(pr, options({ root: join(scratch, 'storage-merged') }));
    assert.equal(c.baseOid, fake.baseOid, 'the base just before the merge');
    assert.equal(c.mergeBase, fake.baseOid);
    assert.equal(await pullRequestDiff(pr, c), expected);
    assert.deepEqual(c.warnings, []);
  });

  it('merged, with baseRefOid: compared with where the base was', async () => {
    const pr = details({ state: 'MERGED', mergeCommit: { oid: merge } });
    const c = await prepareCheckout(pr, options({ root: join(scratch, 'storage-merged-oid') }));
    assert.equal(c.mergeBase, fake.baseOid);
    assert.equal(await pullRequestDiff(pr, c), expected);
  });

  it('closed, its base branch deleted since: still reviewable from baseRefOid', async () => {
    const pr = details({ state: 'CLOSED', baseRefName: 'release/gone' });
    const c = await prepareCheckout(pr, options({ root: join(scratch, 'storage-closed') }));
    assert.equal(await pullRequestDiff(pr, c), expected);
  });

  it('a base commit GitHub no longer has: the branch as it is now, with a warning', async () => {
    const pr = details({ state: 'CLOSED', baseRefOid: '7'.repeat(40) });
    const c = await prepareCheckout(pr, options({ root: join(scratch, 'storage-closed-gone') }));
    assert.equal(c.baseOid, merge, 'main now');
    assert.ok(c.warnings.some((w) => /no longer has the base this closed pull request had, so it is compared with main as it is now/.test(w)), c.warnings.join('\n'));
  });

  it('an open PR is still compared with its branch now', async () => {
    const c = await prepareCheckout(details(), options({ root: join(scratch, 'storage-open-after-merge') }));
    assert.equal(c.baseOid, merge);
    assert.equal(c.mergeBase, fake.headOid, 'main contains the head now');
  });
});

describe('the dependency index (finding: read from the PR author\'s head)', () => {
  let repo: string;
  const commit = (files: Record<string, string | { link: string }>, message: string) => {
    for (const [path, content] of Object.entries(files)) {
      const abs = join(repo, path);
      rmSync(abs, { recursive: true, force: true });
      mkdirSync(resolve(abs, '..'), { recursive: true });
      if (typeof content === 'string') writeFileSync(abs, content);
      else symlinkSync(content.link, abs);
    }
    sh(repo, ['add', '-A']);
    sh(repo, ['commit', '--quiet', '--no-verify', '--allow-empty', '-m', message]);
    return sh(repo, ['rev-parse', 'HEAD']).trim();
  };
  before(() => {
    repo = mkdtempSync(join(scratch, 'index-'));
    sh(repo, ['init', '--quiet']);
    sh(repo, ['config', 'core.symlinks', 'true']);
  });

  it('is read from the commit given, not from the files on disk', async () => {
    const base = commit({ '.filos/dependency-index.json': '{"from": "base"}' }, 'base');
    commit({ '.filos/dependency-index.json': '{"from": "the PR"}' }, 'head');
    assert.deepEqual(await dependencyIndexAt(repo, base, {}), { text: '{"from": "base"}' });
    assert.deepEqual(await dependencyIndexAt(repo, sh(repo, ['rev-parse', 'HEAD']).trim(), {}), { text: '{"from": "the PR"}' });
  });

  it('none at that commit: no index, no warning', async () => {
    const c = commit({ '.filos': '' }, 'no index');
    assert.deepEqual(await dependencyIndexAt(repo, c, {}), {});
  });

  it('a symlink, a submodule-like entry or an oversize file is ignored, with a warning', async () => {
    rmSync(join(repo, '.filos'), { recursive: true, force: true });
    const link = commit({ '.filos/dependency-index.json': { link: '/etc/passwd' } }, 'link');
    assert.match((await dependencyIndexAt(repo, link, {})).warning ?? '', /not a regular file/);
    const dirLink = commit({ '.filos': { link: '/etc' } }, 'dir link');
    assert.deepEqual(await dependencyIndexAt(repo, dirLink, {}), {}, 'git never looks through a symlinked .filos');
    rmSync(join(repo, '.filos'), { force: true });
    const big = commit({ '.filos/dependency-index.json': 'x'.repeat(5 * 1024 * 1024 + 1) }, 'big');
    assert.match((await dependencyIndexAt(repo, big, {})).warning ?? '', /over the 5 MB limit/);
  });

  it('prepareCheckout reads it from the merge base: what the PR changes there is not used', async () => {
    const sample = join(scratch, 'sample-with-index');
    cpSync(resolve(__dirname, '../../fixtures/sample-repo'), sample, { recursive: true });
    mkdirSync(join(sample, 'base', '.filos'), { recursive: true });
    writeFileSync(join(sample, 'base', '.filos', 'dependency-index.json'), '{"version": 1, "from": "base"}\n');
    writeFileSync(join(sample, 'head', '.filos', 'dependency-index.json'), '{"version": 1, "symbols": [], "note": "roundToCents has no consumers"}\n');
    const remote = makeRemote(join(scratch, 'github-index'), { sample });
    const pr = pullRequestDetailsFromView(remote.pr);
    assert.ok(pr.ok);
    const c = await prepareCheckout(pr.pr, options({ root: join(scratch, 'storage-index') }, { FAKE_GH_REMOTE: remote.remote }));
    assert.match(readFileSync(join(c.worktree, '.filos', 'dependency-index.json'), 'utf8'), /no consumers/, 'the worktree has the PR\'s copy');
    assert.equal(c.dependencyIndex.text, '{"version": 1, "from": "base"}\n');
  });
});

describe('several VS Code windows on one storage (finding: prepare was serialised per window only)', () => {
  it("waits while another window holds the clone's lock, and goes on once that window is gone", async () => {
    const other = join(scratch, 'storage-lock');
    const pr = details();
    const paths = checkoutPaths(other, pr);
    mkdirSync(paths.base, { recursive: true });
    const window = otherWindow();
    writeFileSync(join(paths.base, LOCK_FILE), ownerOf(window.pid));
    const stages: string[] = [];
    let done = false;
    const running = prepareCheckout(pr, options({ root: other, onProgress: (stage, text) => stages.push(`${stage}: ${text}`) })).finally(() => (done = true));
    await until('the wait to be reported', () => stages.length > 0);
    assert.deepEqual(stages, ['wait: waiting for another VS Code window, which is getting acme/ledger']);
    await new Promise((r) => setTimeout(r, 400));
    assert.equal(done, false, 'nothing happens while the other window holds the lock');
    assert.equal(ghCalls().filter((x) => x.argv[1] === 'clone' && x.argv[3].startsWith(paths.base)).length, 0);
    window.kill();
    const c = await running;
    assert.equal(c.cloned, true);
    assert.ok(!existsSync(join(paths.base, LOCK_FILE)), 'released');
  });

  it('a wait for the lock can be cancelled', async () => {
    const other = join(scratch, 'storage-lock-cancel');
    const paths = checkoutPaths(other, details());
    mkdirSync(paths.base, { recursive: true });
    const window = otherWindow();
    try {
      writeFileSync(join(paths.base, LOCK_FILE), ownerOf(window.pid));
      const abort = new AbortController();
      const running = prepareCheckout(details(), options({ root: other, signal: abort.signal, onProgress: () => abort.abort() }));
      await assert.rejects(running, (e: unknown) => e instanceof PrError && e.kind === 'cancelled');
      assert.equal(readFileSync(join(paths.base, LOCK_FILE), 'utf8'), ownerOf(window.pid), "the other window's lock stays");
    } finally {
      window.kill();
    }
  });

  it("an older worktree another window is reviewing is kept; this window's own older ones go", async () => {
    const other = join(scratch, 'storage-lease');
    const pr = details();
    const old = await prepareCheckout(pr, options({ root: other }));
    const window = otherWindow();
    const logged: string[] = [];
    try {
      // The other window reviews the old head: it holds a lease on that worktree.
      writeFileSync(join(old.paths.leases, `${worktreeName(9, fake.headOid)}@${window.pid}-${'f'.repeat(16)}`), ownerOf(window.pid));
      const moved = pushToPullRequest(fake, 'src/money/round.ts', '// moved\n');
      const c = await prepareCheckout({ ...pr, headRefOid: moved }, options({ root: other, log: (m) => logged.push(m) }));
      assert.ok(existsSync(old.worktree), 'kept for the other window');
      assert.ok(existsSync(join(old.worktree, 'src/money/round.ts')));
      assert.ok(logged.some((m) => m.includes('another VS Code window is reviewing it')), logged.join('\n'));
      c.lease.release();
      window.kill();
      await until('the other window to be gone', () => {
        try {
          process.kill(window.pid, 0);
          return false;
        } catch {
          return true;
        }
      });
      // That window is gone (its lease is stale): the next prepare tidies the old worktree away.
      const again = await prepareCheckout({ ...pr, headRefOid: moved }, options({ root: other }));
      assert.ok(!existsSync(old.worktree));
      assert.equal(again.worktree, c.worktree);
    } finally {
      window.kill();
      sh(fake.remote, ['update-ref', `refs/pull/${fake.number}/head`, fake.headOid]);
    }
  });

  it('"Delete Pull Request Checkouts" keeps what another window uses and deletes the rest', async () => {
    const other = join(scratch, 'storage-delete');
    const pr = details();
    const mine = await prepareCheckout(pr, options({ root: other }));
    const second = makeRemote(join(scratch, 'github-second'), { number: 4 });
    const secondPr = pullRequestDetailsFromView({ ...second.pr, url: 'https://github.com/acme/billing/pull/4' });
    assert.ok(secondPr.ok);
    const theirs = await prepareCheckout(secondPr.pr, options({ root: other }, { FAKE_GH_REMOTE: second.remote }));
    const window = otherWindow();
    try {
      writeFileSync(join(theirs.paths.leases, `${basenameOf(theirs.worktree)}@${window.pid}-${'f'.repeat(16)}`), ownerOf(window.pid));
      mine.lease.release();
      theirs.lease.release();
      const r = await deleteCheckouts(other);
      assert.deepEqual(r.kept, ['github.com/acme/billing']);
      assert.ok(!existsSync(mine.paths.base), 'acme/ledger is gone');
      assert.ok(existsSync(join(theirs.worktree, 'src/money/round.ts')), 'acme/billing is whole');
      window.kill();
      await until('the other window to be gone', () => {
        try {
          process.kill(window.pid, 0);
          return false;
        } catch {
          return true;
        }
      });
      assert.deepEqual(await deleteCheckouts(other), { kept: [] });
      assert.ok(!existsSync(other), 'nothing left');
    } finally {
      window.kill();
    }
  });

  it('a repository whose lock another window holds is kept whole', async () => {
    const other = join(scratch, 'storage-delete-locked');
    const c = await prepareCheckout(details(), options({ root: other }));
    c.lease.release();
    const window = otherWindow();
    try {
      writeFileSync(join(c.paths.base, LOCK_FILE), ownerOf(window.pid));
      assert.deepEqual(await deleteCheckouts(other), { kept: ['github.com/acme/ledger'] });
      assert.ok(existsSync(c.repoDir));
    } finally {
      window.kill();
    }
  });
});

const basenameOf = (p: string) => p.split(/[\\/]/).pop()!;

describe('file-system failures (finding: reported as Claude Code failures)', { skip: process.platform === 'win32' || process.getuid?.() === 0 }, () => {
  it('storage Filos may not write to is a PrError naming the folder', async () => {
    const locked = join(scratch, 'readonly-parent');
    mkdirSync(locked, { recursive: true });
    chmodSync(locked, 0o500);
    try {
      assert.throws(() => ensureStorage(join(locked, 'prs')), (e: unknown) => e instanceof PrError && e.kind === 'failed' && /isn't allowed to change/.test(e.message) && /EACCES/.test(e.detail ?? ''));
      await assert.rejects(prepareCheckout(details(), options({ root: join(locked, 'prs') })), (e: unknown) => e instanceof PrError && e.kind === 'failed' && e.message.includes(locked));
    } finally {
      chmodSync(locked, 0o700);
    }
  });

  it("an older checkout that can't be removed is logged, and the review goes on", async () => {
    const other = join(scratch, 'storage-stuck');
    const pr = details();
    const old = await prepareCheckout(pr, options({ root: other }));
    old.lease.release();
    // A folder in the old checkout that can't be emptied (as a file held open on Windows would be).
    const stuck = join(old.worktree, 'src', 'money');
    chmodSync(stuck, 0o500);
    const logged: string[] = [];
    const moved = pushToPullRequest(fake, 'README.md', '# moved\n');
    try {
      const c = await prepareCheckout({ ...pr, headRefOid: moved }, options({ root: other, log: (m) => logged.push(m) }));
      assert.equal(c.headOid, moved);
      assert.ok(logged.some((m) => m.startsWith(`couldn't remove the older checkout ${old.worktree}`)), logged.join('\n'));
    } finally {
      chmodSync(stuck, 0o700);
      sh(fake.remote, ['update-ref', `refs/pull/${fake.number}/head`, fake.headOid]);
    }
  });
});

describe('re-runs at the same head', () => {
  it('cancelling during the reuse check keeps the checkout (finding: it was deleted)', async () => {
    const other = join(scratch, 'storage-cancel-reuse');
    const pr = details();
    const first = await prepareCheckout(pr, options({ root: other }));
    first.lease.release();
    const abort = new AbortController();
    // Cancelled just as the existing checkout is being checked.
    const running = prepareCheckout(pr, options({ root: other, signal: abort.signal, onProgress: (stage) => stage === 'checkout' && abort.abort() }));
    await assert.rejects(running, (e: unknown) => e instanceof PrError && e.kind === 'cancelled');
    assert.ok(existsSync(join(first.worktree, 'src/money/round.ts')), 'still there');
    const again = await prepareCheckout(pr, options({ root: other }));
    assert.equal(again.reusedWorktree, true, 'and reused next time');
  });

  it("a checkout left locked by a killed `worktree add` doesn't block the PR (finding: failed on every attempt)", async () => {
    const other = join(scratch, 'storage-initializing');
    const pr = details();
    const first = await prepareCheckout(pr, options({ root: other }));
    first.lease.release();
    // What a SIGKILL mid-checkout leaves: the entry locked ("initializing"), the folder half made.
    sh(first.repoDir, ['worktree', 'lock', '--reason', 'initializing', first.worktree]);
    rmSync(first.worktree, { recursive: true, force: true });
    const again = await prepareCheckout(pr, options({ root: other }));
    assert.equal(again.reusedWorktree, false);
    assert.equal(sh(again.worktree, ['rev-parse', 'HEAD']).trim(), fake.headOid);
    assert.ok(!sh(again.repoDir, ['worktree', 'list', '--porcelain']).includes('locked'), 'no lock left');

    // An older head's entry, locked the same way, is tidied when the PR moves on.
    again.lease.release();
    sh(again.repoDir, ['worktree', 'lock', '--reason', 'initializing', again.worktree]);
    const moved = pushToPullRequest(fake, 'README.md', '# moved once more\n');
    try {
      const c = await prepareCheckout({ ...pr, headRefOid: moved }, options({ root: other }));
      assert.ok(!existsSync(again.worktree));
      const list = sh(c.repoDir, ['worktree', 'list', '--porcelain']);
      assert.ok(!list.includes(again.worktree) && !list.includes('locked'), list);
    } finally {
      sh(fake.remote, ['update-ref', `refs/pull/${fake.number}/head`, fake.headOid]);
    }
  });
});

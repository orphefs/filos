// Host git helpers that need no VS Code: parsing, warnings, and diff behaviour on a real temp repo.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import * as git from '../../src/host/git';
import { diffHeadLines } from '../../src/review/github';

const scratch = mkdtempSync(join(tmpdir(), 'filos-git-'));
after(() => rmSync(scratch, { recursive: true, force: true }));

const ENV = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t.invalid', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
const sh = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'commit.gpgsign=false', ...args], { cwd, env: ENV, encoding: 'utf8' });

describe('git helpers', () => {
  it('parseBranchRefs keeps local and remote-tracking branches, drops */HEAD', () => {
    const out = ['refs/heads/feature', 'refs/heads/main', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/develop', 'refs/remotes/upstream/main', ''].join('\n');
    assert.deepEqual(git.parseBranchRefs(out), ['feature', 'main', 'origin/develop', 'upstream/main']);
  });

  it('parseGitVersion reads the usual version strings', () => {
    assert.deepEqual(git.parseGitVersion('git version 2.43.0\n'), [2, 43]);
    assert.deepEqual(git.parseGitVersion('git version 2.39.3 (Apple Git-146)'), [2, 39]);
    assert.deepEqual(git.parseGitVersion('git version 2.45.1.windows.1'), [2, 45]);
    assert.equal(git.parseGitVersion('nonsense'), undefined);
  });

  it('diffWarnings names binary files and a changed .gitattributes', () => {
    const d = [
      'diff --git a/.gitattributes b/.gitattributes',
      '--- /dev/null',
      '+++ b/.gitattributes',
      '@@ -0,0 +1 @@',
      '+check.ts -diff',
      'diff --git a/check.ts b/check.ts',
      'index f5745da..cd7c3f6 100644',
      'Binary files a/check.ts and b/check.ts differ',
      'diff --git a/logo.png b/logo.png',
      'new file mode 100644',
      'Binary files /dev/null and b/logo.png differ',
    ].join('\n');
    const w = git.diffWarnings(d);
    assert.equal(w.length, 2);
    assert.match(w[0], /2 files as binary.*check\.ts, logo\.png/);
    assert.match(w[1], /\.gitattributes/);
    assert.deepEqual(git.diffWarnings('diff --git a/x.ts b/x.ts\n@@ -1 +1 @@\n-a\n+b'), []);
    assert.match(git.diffWarnings('diff --git a/sub/.gitattributes b/sub/.gitattributes\n')[0], /\.gitattributes/);
  });

  it('a missing folder is not a repo, and is not reported as "git is not installed"', async () => {
    const gone = join(scratch, 'no-such-folder');
    assert.equal(await git.repoRoot(gone), undefined);
    await assert.rejects(git.git(gone, ['status']), (e: unknown) => e instanceof git.GitError && e.code === git.FOLDER_NOT_FOUND && /folder not found/.test(e.message));
  });
});

describe('git.diff on a real repo', () => {
  const repo = join(scratch, 'repo');
  before(() => {
    mkdirSync(repo);
    sh(repo, 'init', '--quiet');
    sh(repo, 'symbolic-ref', 'HEAD', 'refs/heads/main');
    writeFileSync(join(repo, 'check.ts'), 'export const ok = (u) => u.isAdmin;\n');
    sh(repo, 'add', '-A');
    sh(repo, 'commit', '--quiet', '-m', 'base');
    sh(repo, 'checkout', '--quiet', '-b', 'pr');
    writeFileSync(join(repo, 'check.ts'), 'export const ok = (u) => true;\n');
    // The PR tries to hide its own change: "-diff" makes git print "Binary files ... differ".
    writeFileSync(join(repo, '.gitattributes'), 'check.ts -diff\n');
    sh(repo, 'add', '-A');
    sh(repo, 'commit', '--quiet', '-m', 'pr');
  });

  it("reads attributes from the merge base (git 2.40+), so the PR's .gitattributes can't hide a change", async (t) => {
    const v = git.parseGitVersion(sh(repo, '--version'));
    if (!v || v[0] < 2 || (v[0] === 2 && v[1] < 40)) {
      t.skip('git older than 2.40 has no --attr-source');
      return;
    }
    const d = await git.diff(repo, 'main', 'pr');
    assert.match(d, /\+export const ok = \(u\) => true;/);
    assert.ok(!/Binary files/.test(d));
    assert.deepEqual(git.diffWarnings(d).length, 1, 'still warns that .gitattributes changed');
  });

  it("shapes hunks as GitHub does, whatever the user's diff settings", async () => {
    const r = join(scratch, 'context-repo');
    mkdirSync(r);
    sh(r, 'init', '--quiet');
    sh(r, 'symbolic-ref', 'HEAD', 'refs/heads/main');
    const lines = Array.from({ length: 40 }, (_, i) => `line ${i + 1}`);
    writeFileSync(join(r, 'f.txt'), lines.join('\n') + '\n');
    sh(r, 'add', '-A');
    sh(r, 'commit', '--quiet', '-m', 'base');
    sh(r, 'checkout', '--quiet', '-b', 'pr');
    // Two changes 10 lines apart: separate hunks at GitHub's 3 lines of context, one hunk (and
    // lines 24-26 commentable) with the user's interHunkContext; 10 lines of context would widen both.
    writeFileSync(join(r, 'f.txt'), lines.map((l, i) => (i === 19 || i === 29 ? `${l} changed` : l)).join('\n') + '\n');
    sh(r, 'commit', '--quiet', '-am', 'pr');
    const config = join(scratch, 'wide.gitconfig');
    writeFileSync(config, '[diff]\n\tcontext = 10\n\tinterHunkContext = 10\n\talgorithm = histogram\n');
    const d = await git.diff(r, 'main', 'pr', { env: { GIT_CONFIG_GLOBAL: config, GIT_CONFIG_NOSYSTEM: '1' } });
    const hunks = d.split('\n').filter((l) => l.startsWith('@@')).map((l) => l.replace(/ @@.*$/, ' @@'));
    assert.deepEqual(hunks, ['@@ -17,7 +17,7 @@', '@@ -27,7 +27,7 @@']);
    const head = [...(diffHeadLines(d).get('f.txt') ?? [])];
    assert.deepEqual(head, [17, 18, 19, 20, 21, 22, 23, 27, 28, 29, 30, 31, 32, 33], 'only lines GitHub shows are commentable');
  });

  it('turns a diff over the buffer limit into a clear error', async () => {
    await assert.rejects(git.diff(repo, 'main', 'pr', { maxBuffer: 10 }), (e: unknown) => e instanceof git.GitError && /is larger than .* MB, too large to review/.test(e.message));
  });

  it('branches lists local and remote-tracking branches without */HEAD', async () => {
    sh(repo, 'update-ref', 'refs/remotes/origin/develop', 'main');
    sh(repo, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/develop');
    const names = await git.branches(repo);
    assert.deepEqual([...names].sort(), ['main', 'origin/develop', 'pr']);
  });
});

describe('git.git stops everything git started', { skip: process.platform === 'win32' }, () => {
  // A shell alias stands in for what git starts itself: in a blobless clone, `worktree add`, `diff`
  // and `cat-file` start a `git fetch` for missing blobs. Killing git alone left that one running.
  const pidOf = async (file: string) => {
    const end = Date.now() + 5000;
    while (!existsSync(file) || !readFileSync(file, 'utf8').trim()) {
      if (Date.now() > end) throw new Error('the child never started');
      await new Promise((r) => setTimeout(r, 20));
    }
    return Number(readFileSync(file, 'utf8').trim());
  };
  const alive = (pid: number) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  const gone = async (pid: number) => {
    const end = Date.now() + 5000;
    while (alive(pid)) {
      if (Date.now() > end) return false;
      await new Promise((r) => setTimeout(r, 25));
    }
    return true;
  };
  const spawner = (file: string) => ['-c', `alias.spawn=!sleep 60 & echo $! > '${file}'; wait`];

  it('when cancelled', async () => {
    const file = join(scratch, 'child-cancel.pid');
    const abort = new AbortController();
    const running = git.git(scratch, ['spawn'], { config: spawner(file), signal: abort.signal });
    const child = await pidOf(file);
    abort.abort();
    await assert.rejects(running, (e: unknown) => e instanceof git.GitError && e.code === git.ABORTED);
    assert.ok(await gone(child), `the child git started (${child}) is still running`);
  });

  it('when timed out', async () => {
    const file = join(scratch, 'child-timeout.pid');
    const running = git.git(scratch, ['spawn'], { config: spawner(file), timeoutMs: 300 });
    const child = await pidOf(file);
    await assert.rejects(running, (e: unknown) => e instanceof git.GitError && e.code === git.TIMED_OUT);
    assert.ok(await gone(child), `the child git started (${child}) is still running`);
  });

  it('collects large output whole, and stops at maxBuffer', async () => {
    const big = ['-c', `alias.big=!head -c 3000000 /dev/zero | tr '\\0' a`];
    const out = await git.git(scratch, ['big'], { config: big });
    assert.equal(out.length, 3_000_000, 'one long line, whole');
    await assert.rejects(git.git(scratch, ['big'], { config: big, maxBuffer: 1000 }), (e: unknown) => e instanceof git.GitError && e.code === git.OUTPUT_TOO_LARGE);
  });

  it('reports a failing command with its exit code and stderr', async () => {
    await assert.rejects(git.git(scratch, ['rev-parse', '--verify', 'no-such-ref']), (e: unknown) => e instanceof git.GitError && e.code === 128 && /fatal/.test(e.stderr));
  });
});

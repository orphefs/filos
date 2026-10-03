// Builds a local stand-in for a GitHub repository, for the fake gh's `repo clone` (FAKE_GH_REMOTE):
// a bare repo with the bundled sample's base on refs/heads/main and its head on
// refs/heads/feature/bankers-rounding and refs/pull/<n>/head, as GitHub keeps them. Also writes the
// pull request as `gh pr view --json` would answer it (FAKE_GH_PR_JSON), with the real commit ids.
//
//   npx tsx test/fixtures/fake-gh/makeRemote.ts <out-dir> [--number 9] [--hook-marker <file>]
//
// prints {"remote": ..., "prFile": ..., "headOid": ..., "baseOid": ...}. Unit tests import makeRemote.

import { execFileSync } from 'node:child_process';
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const SAMPLE = resolve(__dirname, '../../../fixtures/sample-repo');

/** Fixed identities and dates, so commit ids are the same on every run; no user or system git config. */
const ENV: NodeJS.ProcessEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: 'Filos Test',
  GIT_AUTHOR_EMAIL: 'test@filos.invalid',
  GIT_COMMITTER_NAME: 'Filos Test',
  GIT_COMMITTER_EMAIL: 'test@filos.invalid',
  GIT_AUTHOR_DATE: '2026-09-29T09:00:00+00:00',
  GIT_COMMITTER_DATE: '2026-09-29T09:00:00+00:00',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
};

export const PR_HEAD_BRANCH = 'feature/bankers-rounding';
export const PR_TITLE = "Switch to banker's rounding and add invoice discounts";

export interface FakeRemote {
  /** The bare repository: FAKE_GH_REMOTE. */
  remote: string;
  /** The pull request as `gh pr view --json` gives it: FAKE_GH_PR_JSON. */
  prFile: string;
  pr: Record<string, unknown>;
  number: number;
  baseOid: string;
  headOid: string;
}

export function sh(cwd: string, args: string[], env: NodeJS.ProcessEnv = ENV): string {
  return execFileSync('git', ['-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', '-c', 'core.autocrlf=false', ...args], { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function replaceTree(work: string, from: string): void {
  for (const entry of readdirSync(work)) if (entry !== '.git') rmSync(join(work, entry), { recursive: true, force: true });
  cpSync(from, work, { recursive: true });
}

/** `sample`: the folder with base/ and head/ (defaults to fixtures/sample-repo, found from this file). */
export function makeRemote(outDir: string, opts: { number?: number; sample?: string } = {}): FakeRemote {
  const number = opts.number ?? 9;
  const sample = opts.sample ?? SAMPLE;
  mkdirSync(outDir, { recursive: true });
  const remote = join(outDir, 'remote.git');
  rmSync(remote, { recursive: true, force: true });
  const work = mkdtempSync(join(outDir, 'work-'));
  try {
    sh(work, ['init', '--quiet']);
    sh(work, ['symbolic-ref', 'HEAD', 'refs/heads/main']);
    replaceTree(work, join(sample, 'base'));
    sh(work, ['add', '-A']);
    sh(work, ['commit', '--quiet', '--no-verify', '-m', 'Ledger: money, invoices, VAT and the HTTP handler']);
    sh(work, ['checkout', '--quiet', '-b', PR_HEAD_BRANCH]);
    replaceTree(work, join(sample, 'head'));
    sh(work, ['add', '-A']);
    sh(work, ['commit', '--quiet', '--no-verify', '-m', PR_TITLE], { ...ENV, GIT_AUTHOR_NAME: 'dana', GIT_AUTHOR_DATE: '2026-09-30T15:30:00+00:00', GIT_COMMITTER_DATE: '2026-09-30T16:00:00+00:00' });
    const baseOid = sh(work, ['rev-parse', 'main']).trim();
    const headOid = sh(work, ['rev-parse', 'HEAD']).trim();
    const numstat = sh(work, ['diff', '--numstat', 'main...HEAD'])
      .split('\n')
      .filter(Boolean)
      .map((l) => l.split('\t'));
    const additions = numstat.reduce((n, [a]) => n + (Number(a) || 0), 0);
    const deletions = numstat.reduce((n, [, d]) => n + (Number(d) || 0), 0);

    sh(outDir, ['init', '--quiet', '--bare', remote]);
    // A partial clone over file:// needs the server to allow filters and fetches of single objects.
    sh(remote, ['config', 'uploadpack.allowFilter', 'true']);
    sh(remote, ['config', 'uploadpack.allowAnySHA1InWant', 'true']);
    sh(work, ['push', '--quiet', remote, 'refs/heads/main:refs/heads/main', `refs/heads/${PR_HEAD_BRANCH}:refs/heads/${PR_HEAD_BRANCH}`, `refs/heads/${PR_HEAD_BRANCH}:refs/pull/${number}/head`]);
    sh(remote, ['symbolic-ref', 'HEAD', 'refs/heads/main']);

    const pr = {
      number,
      url: `https://github.com/acme/ledger/pull/${number}`,
      title: PR_TITLE,
      body: "Rounding now goes to the nearest even cent (banker's rounding), and invoices can carry a discount.\n\n<!-- PR template: describe your change -->\n",
      author: { login: 'dana', name: 'Dana', is_bot: false },
      state: 'OPEN',
      isDraft: false,
      baseRefName: 'main',
      headRefName: PR_HEAD_BRANCH,
      headRefOid: headOid,
      baseRefOid: baseOid,
      isCrossRepository: false,
      headRepositoryOwner: { id: 'O_1', login: 'acme' },
      headRepository: { id: 'R_1', name: 'ledger' },
      additions,
      deletions,
      changedFiles: numstat.length,
      updatedAt: '2026-09-30T16:00:00Z',
    };
    const prFile = join(outDir, 'pr.json');
    writeFileSync(prFile, JSON.stringify(pr, null, 2));
    return { remote, prFile, pr, number, baseOid, headOid };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

/**
 * The author pushes again: a new commit on top of refs/pull/<n>/head (and the branch) that changes
 * `file`. Returns the new head.
 */
export function pushToPullRequest(fake: FakeRemote, file: string, content: string): string {
  const work = mkdtempSync(join(resolve(fake.remote, '..'), 'push-'));
  try {
    sh(work, ['init', '--quiet']);
    sh(work, ['fetch', '--quiet', fake.remote, `refs/pull/${fake.number}/head:refs/heads/pr`]);
    sh(work, ['checkout', '--quiet', 'pr']);
    mkdirSync(resolve(work, file, '..'), { recursive: true });
    writeFileSync(join(work, file), content);
    sh(work, ['add', '-A']);
    sh(work, ['commit', '--quiet', '--no-verify', '-m', `Update ${file}`], { ...ENV, GIT_COMMITTER_DATE: '2026-10-01T10:00:00+00:00' });
    const oid = sh(work, ['rev-parse', 'HEAD']).trim();
    sh(work, ['push', '--quiet', '--force', fake.remote, `HEAD:refs/pull/${fake.number}/head`, `HEAD:refs/heads/${PR_HEAD_BRANCH}`]);
    return oid;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

/**
 * A git template directory whose hooks touch `marker` when they run: give it to a clone (as
 * GIT_TEMPLATE_DIR) and any hook git runs in that clone leaves a trace.
 */
export function hookTemplate(dir: string, marker: string): string {
  const hooks = join(dir, 'hooks');
  mkdirSync(hooks, { recursive: true });
  for (const name of ['post-checkout', 'reference-transaction', 'post-index-change', 'post-merge', 'pre-auto-gc', 'fsmonitor-watchman']) {
    const file = join(hooks, name);
    writeFileSync(file, `#!/bin/sh\necho "${name} ran" >> '${marker.replace(/'/g, `'\\''`)}'\nexit 0\n`);
    chmodSync(file, 0o755);
  }
  return dir;
}

// Run as a script (not when imported, or bundled into another entry point).
if (require.main === module && /makeRemote\.[cm]?[jt]s$/.test(process.argv[1] ?? '')) {
  const out = process.argv[2];
  if (!out) {
    process.stderr.write('usage: makeRemote.ts <out-dir> [--number 9]\n');
    process.exit(2);
  }
  const i = process.argv.indexOf('--number');
  const fake = makeRemote(resolve(out), { number: i > 0 ? Number(process.argv[i + 1]) : undefined });
  process.stdout.write(JSON.stringify({ remote: fake.remote, prFile: fake.prFile, headOid: fake.headOid, baseOid: fake.baseOid }) + '\n');
}

// Materialises the bundled sample PR as a real git repo: base committed on main, head committed on
// feature/bankers-rounding. A real repo lets the agent path run `git diff` exactly as it would on
// the user's own code, and gives the code pane real files to open.
//
// The git dir lives beside the work tree (sample-repo.git), not inside it: VS Code's Git extension
// would otherwise find a repo next to files opened from outside the workspace and prompt the user
// to open it, which is noise on a first look at Filos.

import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { git } from './git';

export const SAMPLE_BASE = 'main';
export const SAMPLE_HEAD = 'feature/bankers-rounding';
export const SAMPLE_TITLE = "Switch to banker's rounding and add invoice discounts";

export interface SampleRepo {
  repoRoot: string;
  /** Pass to git calls on the sample (GIT_DIR / GIT_WORK_TREE). */
  gitEnv: NodeJS.ProcessEnv;
  base: string;
  head: string;
  prTitle: string;
  /** False when an up-to-date copy from an earlier run was reused. */
  created: boolean;
}

const MARKER = 'filos-sample-marker';

/** Fixed identities and dates, so the sample's commit ids are the same on every machine. */
const SAMPLE_COMMITTER = { GIT_COMMITTER_NAME: 'Filos Sample', GIT_COMMITTER_EMAIL: 'sample@filos.invalid', GIT_COMMITTER_DATE: '2026-09-30T16:00:00+00:00' };
const BASE_ENV = { ...SAMPLE_COMMITTER, GIT_AUTHOR_NAME: 'Filos Sample', GIT_AUTHOR_EMAIL: 'sample@filos.invalid', GIT_AUTHOR_DATE: '2026-09-29T09:00:00+00:00', GIT_COMMITTER_DATE: '2026-09-29T09:00:00+00:00' };
const HEAD_ENV = { ...SAMPLE_COMMITTER, GIT_AUTHOR_NAME: 'dana', GIT_AUTHOR_EMAIL: 'dana@acme.invalid', GIT_AUTHOR_DATE: '2026-09-30T15:30:00+00:00' };

/**
 * Ignore the user's global git setup for this throwaway repo: signing would prompt or fail,
 * global hooks could run, and autocrlf would change the bytes the graph's line numbers refer to.
 */
function isolated(gitDir: string): string[] {
  return ['-c', 'commit.gpgsign=false', '-c', 'tag.gpgsign=false', '-c', `core.hooksPath=${join(gitDir, 'no-hooks')}`, '-c', 'core.autocrlf=false', '-c', 'core.safecrlf=false'];
}

/** Ensures the sample repo exists under storageDir and returns where it is. */
export async function materialiseSample(fixturesDir: string, storageDir: string, extensionVersion: string): Promise<SampleRepo> {
  const baseTree = join(fixturesDir, 'sample-repo', 'base');
  const headTree = join(fixturesDir, 'sample-repo', 'head');
  if (!existsSync(baseTree) || !existsSync(headTree)) throw new Error(`The bundled sample is missing from ${fixturesDir}.`);

  const target = join(storageDir, 'sample-repo');
  const gitDir = join(storageDir, 'sample-repo.git');
  const gitEnv = { GIT_DIR: gitDir, GIT_WORK_TREE: target };
  const fingerprint = `${extensionVersion}:${treeHash(baseTree)}:${treeHash(headTree)}`;
  if (await isReusable(target, gitDir, gitEnv, fingerprint)) {
    return { repoRoot: realpathSync(target), gitEnv, base: SAMPLE_BASE, head: SAMPLE_HEAD, prTitle: SAMPLE_TITLE, created: false };
  }

  rmSync(target, { recursive: true, force: true });
  rmSync(gitDir, { recursive: true, force: true });
  mkdirSync(target, { recursive: true });
  const run = (args: string[], env?: NodeJS.ProcessEnv) => git(target, [...isolated(gitDir), ...args], { env: { ...gitEnv, ...env } });

  // `git init -b` needs git 2.28; symbolic-ref works everywhere.
  await run(['init', '--quiet']);
  await run(['symbolic-ref', 'HEAD', `refs/heads/${SAMPLE_BASE}`]);
  cpSync(baseTree, target, { recursive: true });
  await run(['add', '-A']);
  await run(['commit', '--quiet', '--no-verify', '-m', 'Ledger: money, invoices, VAT and the HTTP handler'], BASE_ENV);

  await run(['checkout', '--quiet', '-b', SAMPLE_HEAD]);
  // Replace the tree with head, so files absent from head (if any) are deleted by the commit.
  for (const entry of readdirSync(target)) rmSync(join(target, entry), { recursive: true, force: true });
  cpSync(headTree, target, { recursive: true });
  await run(['add', '-A']);
  await run(['commit', '--quiet', '--no-verify', '-m', SAMPLE_TITLE], HEAD_ENV);

  writeFileSync(join(gitDir, MARKER), fingerprint);
  return { repoRoot: realpathSync(target), gitEnv, base: SAMPLE_BASE, head: SAMPLE_HEAD, prTitle: SAMPLE_TITLE, created: true };
}

/** Reuse only an untouched copy made from the same fixtures: on the head branch, clean, same marker. */
async function isReusable(target: string, gitDir: string, env: NodeJS.ProcessEnv, fingerprint: string): Promise<boolean> {
  try {
    if (!existsSync(target) || readFileSync(join(gitDir, MARKER), 'utf8') !== fingerprint) return false;
    const branch = (await git(target, ['rev-parse', '--abbrev-ref', 'HEAD'], { env })).trim();
    if (branch !== SAMPLE_HEAD) return false;
    return (await git(target, ['status', '--porcelain'], { env })).trim() === '';
  } catch {
    return false;
  }
}

/** Content hash of a directory tree (paths + bytes), so edited fixtures invalidate the cached repo. */
function treeHash(root: string): string {
  const h = createHash('sha256');
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) walk(abs);
      else if (entry.isFile()) {
        h.update(relative(root, abs).split('\\').join('/'));
        h.update('\0');
        h.update(readFileSync(abs));
        h.update('\0');
      }
    }
  };
  walk(root);
  return h.digest('hex').slice(0, 16);
}

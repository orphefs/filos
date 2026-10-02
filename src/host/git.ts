// Small git helpers for the host. execFile with an argument array (no shell), so branch names and
// paths are never interpreted by a shell.

import { execFile } from 'node:child_process';

export class GitError extends Error {
  constructor(
    message: string,
    readonly stderr: string,
    readonly code?: number | string,
  ) {
    super(message);
    this.name = 'GitError';
  }
}

export interface GitOptions {
  env?: NodeJS.ProcessEnv;
  /** Diffs can be large; the default covers most real PRs. */
  maxBuffer?: number;
}

/** Settings that make our own git calls independent of the user's config (pagers, colour, hooks, signing). */
const NEUTRAL_CONFIG = ['-c', 'color.ui=false', '-c', 'core.quotepath=false', '-c', 'core.pager=cat'];

export function git(cwd: string, args: readonly string[], opts: GitOptions = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      [...NEUTRAL_CONFIG, ...args],
      { cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', ...opts.env }, maxBuffer: opts.maxBuffer ?? 64 * 1024 * 1024, windowsHide: true },
      (err, stdout, stderr) => {
        if (err) {
          const e = err as NodeJS.ErrnoException & { code?: number | string };
          const missing = e.code === 'ENOENT';
          reject(new GitError(missing ? 'git is not installed or not on PATH' : `git ${args[0]} failed: ${String(stderr).trim() || e.message}`, String(stderr ?? ''), e.code));
          return;
        }
        resolve(String(stdout));
      },
    );
  });
}

/** Repository root containing dir, or undefined if dir is not inside a git work tree. */
export async function repoRoot(dir: string): Promise<string | undefined> {
  try {
    return (await git(dir, ['rev-parse', '--show-toplevel'])).trim() || undefined;
  } catch (e) {
    if (e instanceof GitError && e.code === 'ENOENT') throw e;
    return undefined;
  }
}

async function refExists(root: string, ref: string): Promise<boolean> {
  try {
    await git(root, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
    return true;
  } catch {
    return false;
  }
}

/**
 * The branch a PR from HEAD would most likely target: origin/HEAD's branch, else main, else master.
 * Returns the ref to diff against (e.g. "origin/main"), or undefined if none exists.
 */
export async function defaultBaseRef(root: string): Promise<string | undefined> {
  try {
    const sym = (await git(root, ['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD'])).trim();
    const ref = sym.replace(/^refs\/remotes\//, '');
    if (ref && (await refExists(root, ref))) return ref;
  } catch {
    // no origin/HEAD: fall through to the usual names
  }
  for (const name of ['main', 'master', 'origin/main', 'origin/master']) {
    if (await refExists(root, name)) return name;
  }
  return undefined;
}

export async function localBranches(root: string): Promise<string[]> {
  const out = await git(root, ['for-each-ref', '--format=%(refname:short)', '--sort=-committerdate', 'refs/heads']);
  return out.split('\n').map((s) => s.trim()).filter(Boolean);
}

/** Current branch name, or the short commit id when HEAD is detached. */
export async function currentBranch(root: string): Promise<string> {
  const name = (await git(root, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
  return name === 'HEAD' ? (await git(root, ['rev-parse', '--short', 'HEAD'])).trim() : name;
}

export async function mergeBase(root: string, a: string, b: string): Promise<string | undefined> {
  try {
    return (await git(root, ['merge-base', a, b])).trim() || undefined;
  } catch {
    return undefined;
  }
}

/** Unified diff of committed changes base...head (i.e. since their merge base). */
export function diff(root: string, base: string, head: string, opts: GitOptions = {}): Promise<string> {
  return git(root, ['diff', '--no-color', '--no-ext-diff', '--no-textconv', '-M', '--src-prefix=a/', '--dst-prefix=b/', `${base}...${head}`, '--'], opts);
}

/** Commit subjects in base..head, newest first. */
export async function commitSubjects(root: string, base: string, head: string): Promise<string[]> {
  const out = await git(root, ['log', '--format=%s', `${base}..${head}`]);
  return out.split('\n').map((s) => s.trim()).filter(Boolean);
}

export async function hasUncommittedChanges(root: string): Promise<boolean> {
  return (await git(root, ['status', '--porcelain', '--untracked-files=normal'])).trim().length > 0;
}

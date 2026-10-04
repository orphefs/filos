// Small git helpers for the host. An argument array (no shell), so branch names and paths are never
// interpreted by a shell. git runs in a process group of its own (runProcess), so cancelling or
// timing out a call also stops what git started: in a blobless clone, `worktree add`, `diff` and
// `cat-file` start a `git fetch` child for missing blobs, which a kill of git alone would orphan.

import { statSync } from 'node:fs';
import { resolveCommand, runProcess } from '../agent/exec';

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
  /** Global options placed before the subcommand, e.g. ['-c', 'core.hooksPath=/dev/null']. */
  config?: readonly string[];
  /** Kills git (and everything it started) when aborted (GitError code ABORTED). */
  signal?: AbortSignal;
  /** Kills git (and everything it started) after this long (GitError code TIMED_OUT). For calls that may go to the network. */
  timeoutMs?: number;
}

/** Settings that make our own git calls independent of the user's config (pagers, colour, hooks, signing). */
const NEUTRAL_CONFIG = ['-c', 'color.ui=false', '-c', 'core.quotepath=false', '-c', 'core.pager=cat'];

const MiB = 1024 * 1024;
const DEFAULT_MAX_BUFFER = 64 * MiB;

/** GitError codes for the two failures that look alike when spawning (both ENOENT). */
export const GIT_NOT_FOUND = 'ENOENT';
export const FOLDER_NOT_FOUND = 'ENOTDIR';
/** GitError code when output passes maxBuffer (git is killed). */
export const OUTPUT_TOO_LARGE = 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER';
/** GitError codes for a call stopped by its signal or its timeout. */
export const ABORTED = 'ABORTED';
export const TIMED_OUT = 'TIMED_OUT';

export async function git(cwd: string, args: readonly string[], opts: GitOptions = {}): Promise<string> {
  // On Windows a bare "git" would be looked up in cwd first, i.e. in the repo under review.
  const exe = resolveCommand('git');
  if (!exe) throw new GitError('git is not installed or not on PATH', '', GIT_NOT_FOUND);
  const maxBuffer = opts.maxBuffer ?? DEFAULT_MAX_BUFFER;
  const sub = subcommand(args);
  if (opts.signal?.aborted) throw new GitError(`git ${sub} was cancelled`, '', ABORTED);
  const r = await runProcess({
    command: exe,
    args: [...NEUTRAL_CONFIG, ...(opts.config ?? []), ...args],
    cwd,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', ...opts.env },
    signal: opts.signal,
    timeoutMs: opts.timeoutMs,
    collectStdout: true,
    // One byte over the cap is enough to tell "too large" from "exactly the cap".
    maxCollectBytes: maxBuffer + 1,
    maxStdoutBytes: maxBuffer,
    stderrTailBytes: 64 * 1024,
  });
  const stderr = r.stderrTail;
  if (r.spawnError) {
    // A missing cwd is reported as ENOENT too; it must not read as "git is not installed".
    if (r.spawnError.code === 'ENOENT') throw isDirectory(cwd) ? new GitError('git is not installed or not on PATH', '', GIT_NOT_FOUND) : new GitError(`folder not found: ${cwd}`, '', FOLDER_NOT_FOUND);
    throw new GitError(`git ${sub} could not start: ${r.spawnError.message}`, '', r.spawnError.code);
  }
  if (r.aborted) throw new GitError(`git ${sub} was cancelled`, stderr, ABORTED);
  if (r.timedOut) throw new GitError(`git ${sub} didn't finish within ${Math.round((opts.timeoutMs ?? 0) / 1000)} seconds`, stderr, TIMED_OUT);
  if (r.overflow) throw new GitError(`git ${sub} printed more than ${Math.round(maxBuffer / MiB)} MB`, '', OUTPUT_TOO_LARGE);
  if (r.exitCode !== 0) {
    if (missingDeveloperTools(stderr)) throw new GitError(DEVELOPER_TOOLS_MESSAGE, stderr, GIT_NOT_FOUND);
    const how = r.exitCode === null ? `signal ${r.signal ?? '?'}` : `exit code ${r.exitCode}`;
    throw new GitError(`git ${sub} failed: ${stderr.trim() || how}`, stderr, r.exitCode ?? r.signal ?? undefined);
  }
  return r.stdout;
}

/**
 * Whether git's stderr says it can't run because Apple's Command Line Tools are missing: macOS's
 * /usr/bin/git is only a stub until they are installed ("xcrun: error: invalid active developer
 * path (/Library/Developer/CommandLineTools), missing xcrun at: …"), and macOS offers to install
 * them. Read as git not being installed, not as a failed command ("not a git repository").
 */
export function missingDeveloperTools(stderr: string): boolean {
  return /xcrun: error: invalid active developer path|no developer tools were found|requires the command line developer tools/i.test(stderr);
}

export const DEVELOPER_TOOLS_MESSAGE =
  'git on this Mac needs Apple\'s Command Line Tools, which aren\'t installed. Install them (macOS may be offering to already, or run "xcode-select --install" in a terminal), then retry.';

/** The git command in args, past global options such as "-c key=value". For messages. */
function subcommand(args: readonly string[]): string {
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '-c') i++;
    else if (!args[i].startsWith('-')) return args[i];
  }
  return args[0] ?? '';
}

function isDirectory(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** Repository root containing dir, or undefined if dir is not inside a git work tree (or is gone). */
export async function repoRoot(dir: string): Promise<string | undefined> {
  // A folder deleted since the workspace was opened is not a repo; let the caller try the next one.
  if (!isDirectory(dir)) return undefined;
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

/**
 * Local and remote-tracking branches, most recent first, as names diff accepts ("main",
 * "origin/develop"). Symbolic <remote>/HEAD refs are left out: they only point at another branch.
 */
export async function branches(root: string): Promise<string[]> {
  const out = await git(root, ['for-each-ref', '--format=%(refname)', '--sort=-committerdate', 'refs/heads', 'refs/remotes']);
  return parseBranchRefs(out);
}

export function parseBranchRefs(out: string): string[] {
  return out
    .split('\n')
    .map((s) => s.trim())
    .filter((r) => r && !r.endsWith('/HEAD'))
    .map((r) => r.replace(/^refs\/(?:heads|remotes)\//, ''));
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

/**
 * Unified diff of committed changes base...head (i.e. since their merge base).
 * The head's .gitattributes comes with the PR and could mark a changed file "-diff", which hides
 * its lines ("Binary files differ"). On git 2.40+ attributes are read from the merge base instead;
 * diffWarnings flags what is left (older git, real binaries, a changed .gitattributes).
 * Hunks are shaped as GitHub shapes them (3 lines of context, no merged hunks, the default
 * algorithm), whatever the user's diff.* settings say: inline comments are placed on the lines
 * these hunks show, and GitHub refuses a review with a comment on any other line.
 */
export async function diff(root: string, base: string, head: string, opts: GitOptions = {}): Promise<string> {
  const maxBuffer = opts.maxBuffer ?? DEFAULT_MAX_BUFFER;
  const attrs: string[] = [];
  if (await supportsAttrSource(root, opts)) {
    const mb = await git(root, ['merge-base', base, head], { env: opts.env, config: opts.config, signal: opts.signal, timeoutMs: opts.timeoutMs }).then((o) => o.trim(), () => '');
    if (mb) attrs.push(`--attr-source=${mb}`);
  }
  try {
    return await git(root, [...attrs, 'diff', '--no-color', '--no-ext-diff', '--no-textconv', '-M', '-U3', '--inter-hunk-context=0', '--diff-algorithm=myers', '--src-prefix=a/', '--dst-prefix=b/', `${base}...${head}`, '--'], { ...opts, maxBuffer });
  } catch (e) {
    if (e instanceof GitError && e.code === OUTPUT_TOO_LARGE) {
      throw new GitError(
        `The diff between ${base} and ${head} is larger than ${Math.round(maxBuffer / MiB)} MB, too large to review. It probably includes generated files, dumps or vendored code; review a narrower range.`,
        '',
        OUTPUT_TOO_LARGE,
      );
    }
    throw e;
  }
}

let gitVersion: Promise<[number, number] | undefined> | undefined;

/** --attr-source arrived in git 2.40. The version is asked once per session. */
async function supportsAttrSource(root: string, opts: GitOptions): Promise<boolean> {
  gitVersion ??= git(root, ['--version'], { env: opts.env }).then(parseGitVersion, () => undefined);
  const v = await gitVersion;
  if (!v) gitVersion = undefined; // ask again next time rather than remember a failure
  return !!v && (v[0] > 2 || (v[0] === 2 && v[1] >= 40));
}

/** "git version 2.43.0", "git version 2.39.3 (Apple Git-146)", "git version 2.45.1.windows.1". */
export function parseGitVersion(out: string): [number, number] | undefined {
  const m = /(\d+)\.(\d+)/.exec(out);
  return m ? [Number(m[1]), Number(m[2])] : undefined;
}

/** Warnings about parts of a diff the agent cannot see: files git shows as binary, and a changed .gitattributes. */
export function diffWarnings(diffText: string): string[] {
  const binary: string[] = [];
  let attributesChanged = false;
  let current: string | undefined;
  for (const line of diffText.split('\n')) {
    const header = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
    if (header) {
      current = header[2];
      if ([header[1], header[2]].some((p) => p === '.gitattributes' || p.endsWith('/.gitattributes'))) attributesChanged = true;
    } else if (current && line.startsWith('Binary files ') && line.endsWith(' differ')) {
      binary.push(current);
      current = undefined;
    }
  }
  const out: string[] = [];
  if (binary.length) {
    const shown = binary.slice(0, 5).join(', ') + (binary.length > 5 ? ` and ${binary.length - 5} more` : '');
    out.push(`Git shows ${binary.length === 1 ? '1 file' : `${binary.length} files`} as binary, so the agent saw no line changes for ${binary.length === 1 ? 'it' : 'them'}: ${shown}.`);
  }
  if (attributesChanged) out.push('This branch changes .gitattributes, which controls how git shows files in a diff. Review that change yourself.');
  return out;
}

/** Commit subjects in base..head, newest first. */
export async function commitSubjects(root: string, base: string, head: string): Promise<string[]> {
  const out = await git(root, ['log', '--format=%s', `${base}..${head}`]);
  return out.split('\n').map((s) => s.trim()).filter(Boolean);
}

export async function hasUncommittedChanges(root: string): Promise<boolean> {
  return (await git(root, ['status', '--porcelain', '--untracked-files=normal'])).trim().length > 0;
}

/** The origin remote's URL (for the confidence store's repo key), or undefined without one. */
export async function originUrl(root: string): Promise<string | undefined> {
  try {
    return (await git(root, ['remote', 'get-url', 'origin'])).trim() || undefined;
  } catch {
    return undefined;
  }
}

/** The full commit id HEAD points at, or undefined (e.g. an unborn branch). */
export async function headCommit(root: string, opts: GitOptions = {}): Promise<string | undefined> {
  try {
    return (await git(root, ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}'], opts)).trim() || undefined;
  } catch {
    return undefined;
  }
}

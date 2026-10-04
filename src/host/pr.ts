// A GitHub pull request by URL, number or owner/repo#n: look it up with the user's own `gh`, get its
// code into Filos's own storage (never the user's workspace or repo), and compute its diff.
//
// Layout, per repository: <root>/<host>/<owner>/<repo>/repo is a blobless clone with no checkout of
// its own, made once by `gh repo clone` (gh's login works for private repos) and reused; each PR
// head is a detached worktree beside it, <...>/worktrees/pr-<n>-<sha12>. Fetches go into refs of our
// own (refs/filos/pr/<n>/head and /base), so nothing the user owns is touched. Every VS Code window
// shares this storage: a window changes a clone only while it holds that clone's lock, and holds a
// lease on the worktree it reviews, so other windows don't remove it (checkoutLocks.ts).
//
// The PR's content is untrusted: no hook ever runs in these clones (core.hooksPath points nowhere,
// on every call and in the clone's config), symlinks are checked out as plain files (so the agent
// and the code pane can't be led out of the checkout), submodules are never fetched, and LFS files
// stay pointers. Every gh and git call is an argument array (no shell), and every name that ends up
// in a path, a refspec or a command line is checked against a strict pattern first. The editor shows
// the checkout through a read-only file system of Filos's own (prFiles.ts), never as file: URIs.
// No vscode import: unit tests drive it with the fake gh in test/fixtures/fake-gh.

import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, realpathSync, renameSync } from 'node:fs';
import { lstat, readdir, rm } from 'node:fs/promises';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { offPathHint, resolveCommand, runProcess, type RunResult } from '../agent/exec';
import { safeProgressText } from '../agent/progress';
import { INVISIBLE } from '../agent/prompt';
import { normaliseOriginUrl } from '../review/confidence';
import { acquireLock, leasesElsewhere, takeLease, tryLock, type Held } from './checkoutLocks';
import { DEP_INDEX, MAX_DEP_INDEX_BYTES, type DependencyIndexRead } from './depIndex';
import { ghEnv, ghFailure, HOST, OID, OWNER, parsePullRequestUrl, REPO, type PullRequest } from './github';
import * as git from './git';

// ---- input ------------------------------------------------------------------------------------

/** What the user pointed Filos at. A bare number needs a repository (the workspace's) to mean anything. */
export type PullRequestInput =
  | { kind: 'url'; host: string; owner: string; repo: string; number: number; url: string }
  | { kind: 'repo'; owner: string; repo: string; number: number }
  | { kind: 'number'; number: number };

const MAX_NUMBER = 999_999_999;

/**
 * A pull request URL ("https://github.com/acme/ledger/pull/9", also with /files, /commits or
 * /checks after it, a query or a fragment, as copied from a browser; the scheme may be left out),
 * "acme/ledger#9", or "9" / "#9". Undefined for anything else, including names GitHub doesn't allow.
 */
export function parsePullRequestInput(text: string): PullRequestInput | undefined {
  const t = text.trim();
  if (!t || t.length > 500 || /\s/.test(t)) return undefined;
  const n = /^#?(\d{1,9})$/.exec(t);
  if (n) return validNumber(Number(n[1])) ? { kind: 'number', number: Number(n[1]) } : undefined;
  const r = /^([^/#]+)\/([^/#]+)#(\d{1,9})$/.exec(t);
  if (r) {
    if (!validOwner(r[1]) || !validRepo(r[2]) || !validNumber(Number(r[3]))) return undefined;
    return { kind: 'repo', owner: r[1], repo: r[2], number: Number(r[3]) };
  }
  // "github.com/acme/ledger/pull/9" pasted without its scheme.
  const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(t) ? t : /^[a-z0-9.-]+\.[a-z]{2,}(?::\d{1,5})?\//i.test(t) ? `https://${t}` : undefined;
  if (!withScheme) return undefined;
  let u: URL;
  try {
    u = new URL(withScheme);
  } catch {
    return undefined;
  }
  if (u.protocol !== 'https:' || u.username || u.password) return undefined;
  const m = /^\/([^/]+)\/([^/]+)\/pull\/(\d{1,9})(?:\/(?:files|commits|checks)(?:\/[^/]*)?)?\/?$/.exec(u.pathname);
  if (!m) return undefined;
  const host = u.host.toLowerCase();
  if (!HOST.test(host) || !validOwner(m[1]) || !validRepo(m[2]) || !validNumber(Number(m[3]))) return undefined;
  const number = Number(m[3]);
  return { kind: 'url', host, owner: m[1], repo: m[2], number, url: `https://${host}/${m[1]}/${m[2]}/pull/${number}` };
}

const validOwner = (s: string) => OWNER.test(s);
const validRepo = (s: string) => REPO.test(s) && s !== '.' && s !== '..';
const validNumber = (n: number) => Number.isInteger(n) && n >= 1 && n <= MAX_NUMBER;

/** "acme/ledger#9", "#9" or the URL's "acme/ledger#9" (with the host when it isn't github.com). */
export function describeInput(i: PullRequestInput): string {
  switch (i.kind) {
    case 'number':
      return `#${i.number}`;
    case 'repo':
      return `${i.owner}/${i.repo}#${i.number}`;
    case 'url':
      return `${i.host === 'github.com' ? '' : `${i.host}/`}${i.owner}/${i.repo}#${i.number}`;
  }
}

// ---- the pull request -------------------------------------------------------------------------

export type PullRequestState = 'OPEN' | 'CLOSED' | 'MERGED';

/** `gh pr view --json PR_DETAIL_FIELDS`, checked field by field. */
export interface PullRequestDetails {
  host: string;
  owner: string;
  repo: string;
  number: number;
  /** https://<host>/<owner>/<repo>/pull/<n>, as GitHub has it now (after any rename). */
  url: string;
  /** One line, no control characters. Still the author's text: show it as text only. */
  title: string;
  /** The author's description (may be empty). Untrusted. */
  body: string;
  author?: string;
  state: PullRequestState;
  isDraft: boolean;
  /** Checked as a git branch name: it goes into a refspec. */
  baseRefName: string;
  /** The head branch, for display only (it may live in a fork). */
  headRefName: string;
  headRefOid: string;
  /** Where GitHub has the base (it stays put once the PR is closed or merged). Older gh can't say. */
  baseRefOid?: string;
  /** A merged PR's merge (or squash, or last rebased) commit. */
  mergeCommitOid?: string;
  isCrossRepository: boolean;
  /** The fork's owner and name, when the head is in another repository that still exists. */
  headOwner?: string;
  headRepo?: string;
  additions?: number;
  deletions?: number;
  changedFiles?: number;
}

export const PR_DETAIL_FIELDS = 'number,url,title,body,author,state,isDraft,baseRefName,headRefName,headRefOid,baseRefOid,mergeCommit,isCrossRepository,headRepositoryOwner,headRepository,additions,deletions,changedFiles';
/** Fields Filos can do without: an older gh doesn't know them (gh 2.45 has no baseRefOid) and is asked again without. */
const OPTIONAL_DETAIL_FIELDS = new Set(['baseRefOid', 'mergeCommit']);
export const PR_LIST_FIELDS = 'number,url,title,author,headRefName,baseRefName,isDraft,updatedAt,additions,deletions';

const MAX_TITLE = 300;
const MAX_BODY = 65_536;
const LOGIN = /^(?:app\/)?[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})(?:\[bot\])?$/;

/**
 * A branch name git would accept (git check-ref-format --branch), so it can't change the meaning of
 * a refspec or a command line: no ":", "*", "?", "[", "\\", "^", "~", spaces or controls, no "..",
 * "@{", "//", no leading "-" or ".", no trailing "/", "." or ".lock" on any part.
 */
export function isSafeBranchName(name: unknown): name is string {
  if (typeof name !== 'string' || !name || name.length > 255) return false;
  if (/[\x00-\x20\x7f~^:?*[\\]/.test(name) || name.includes('..') || name.includes('@{') || name === '@') return false;
  if (name.startsWith('-') || name.startsWith('/') || name.endsWith('/') || name.endsWith('.') || name.includes('//')) return false;
  return name.split('/').every((part) => part && !part.startsWith('.') && !part.endsWith('.lock'));
}

/** One line of display text: no controls, direction overrides or other invisible characters (INVISIBLE), bounded. */
export function cleanLine(text: string, max: number): string {
  const flat = text
    .replace(INVISIBLE, '')
    .replace(/[\s\x00-\x1f\x7f]+/g, ' ')
    .trim();
  return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat;
}

function cleanBody(text: string): string {
  const t = text.replace(/\r\n?/g, '\n').replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '');
  return t.length > MAX_BODY ? t.slice(0, MAX_BODY) : t;
}

const count = (v: unknown): number | undefined => (typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : undefined);
const login = (v: unknown): string | undefined => {
  const l = v && typeof v === 'object' ? (v as { login?: unknown }).login : undefined;
  return typeof l === 'string' && LOGIN.test(l) ? l : undefined;
};

export type DetailsCheck = { ok: true; pr: PullRequestDetails } | { ok: false; problems: string[] };

export function pullRequestDetailsFromView(raw: unknown): DetailsCheck {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, problems: ['not a JSON object'] };
  const v = raw as Record<string, unknown>;
  const problems: string[] = [];
  const number = v.number;
  if (typeof number !== 'number' || !validNumber(number)) problems.push('number is not a pull request number');
  const where = typeof v.url === 'string' ? parsePullRequestUrl(v.url) : undefined;
  if (!where) problems.push('url is not a pull request URL with valid owner and repository names');
  else if (where.number !== number) problems.push(`url names #${where.number}, not #${String(number)}`);
  if (typeof v.title !== 'string' || !cleanLine(v.title, MAX_TITLE)) problems.push('title is missing');
  if (v.body !== undefined && v.body !== null && typeof v.body !== 'string') problems.push('body is not text');
  const state = typeof v.state === 'string' ? v.state.toUpperCase() : '';
  if (state !== 'OPEN' && state !== 'CLOSED' && state !== 'MERGED') problems.push('state is not OPEN, CLOSED or MERGED');
  if (v.isDraft !== undefined && typeof v.isDraft !== 'boolean') problems.push('isDraft is not a boolean');
  if (!isSafeBranchName(v.baseRefName)) problems.push('baseRefName is not a valid branch name');
  if (typeof v.headRefOid !== 'string' || !OID.test(v.headRefOid)) problems.push('headRefOid is not a commit id');
  if (v.baseRefOid !== undefined && v.baseRefOid !== null && v.baseRefOid !== '' && (typeof v.baseRefOid !== 'string' || !OID.test(v.baseRefOid))) problems.push('baseRefOid is not a commit id');
  const mergeOid = v.mergeCommit && typeof v.mergeCommit === 'object' ? (v.mergeCommit as { oid?: unknown }).oid : undefined;
  if (v.mergeCommit !== undefined && v.mergeCommit !== null && (typeof mergeOid !== 'string' || !OID.test(mergeOid))) problems.push('mergeCommit is not a commit');
  if (v.isCrossRepository !== undefined && typeof v.isCrossRepository !== 'boolean') problems.push('isCrossRepository is not a boolean');
  for (const k of ['additions', 'deletions', 'changedFiles'] as const) {
    if (v[k] !== undefined && count(v[k]) === undefined) problems.push(`${k} is not a count`);
  }
  if (problems.length || !where) return { ok: false, problems };

  const pr: PullRequestDetails = {
    host: where.host,
    owner: where.owner,
    repo: where.repo,
    number: number as number,
    url: v.url as string,
    title: cleanLine(v.title as string, MAX_TITLE),
    body: typeof v.body === 'string' ? cleanBody(v.body) : '',
    state: state as PullRequestState,
    isDraft: v.isDraft === true,
    baseRefName: v.baseRefName as string,
    // Display only; a name git wouldn't accept is replaced rather than shown.
    headRefName: isSafeBranchName(v.headRefName) ? v.headRefName : `pull/${String(number)}/head`,
    headRefOid: v.headRefOid as string,
    isCrossRepository: v.isCrossRepository === true,
  };
  const author = login(v.author);
  if (author) pr.author = author;
  if (typeof v.baseRefOid === 'string' && OID.test(v.baseRefOid)) pr.baseRefOid = v.baseRefOid;
  if (typeof mergeOid === 'string' && OID.test(mergeOid)) pr.mergeCommitOid = mergeOid;
  const headOwner = login(v.headRepositoryOwner);
  const headRepoName = v.headRepository && typeof v.headRepository === 'object' ? (v.headRepository as { name?: unknown }).name : undefined;
  if (headOwner && OWNER.test(headOwner)) pr.headOwner = headOwner;
  if (typeof headRepoName === 'string' && validRepo(headRepoName)) pr.headRepo = headRepoName;
  for (const k of ['additions', 'deletions', 'changedFiles'] as const) {
    const c = count(v[k]);
    if (c !== undefined) pr[k] = c;
  }
  return { ok: true, pr };
}

/** "acme/ledger#9" (with the host when it isn't github.com). */
export function prLabel(pr: Pick<PullRequestDetails, 'host' | 'owner' | 'repo' | 'number'>): string {
  return `${pr.host === 'github.com' ? '' : `${pr.host}/`}${pr.owner}/${pr.repo}#${pr.number}`;
}

/** "#9 · 14 files · +440 −176" for the steps; counts GitHub didn't give are left out. */
export function prSummary(pr: Pick<PullRequestDetails, 'number' | 'changedFiles' | 'additions' | 'deletions'>): string {
  const parts = [`#${pr.number}`];
  if (pr.changedFiles !== undefined) parts.push(`${pr.changedFiles} ${pr.changedFiles === 1 ? 'file' : 'files'}`);
  if (pr.additions !== undefined && pr.deletions !== undefined) parts.push(`+${pr.additions} −${pr.deletions}`);
  return parts.join(' · ');
}

/** The head as GitHub shows it: the branch, or "owner:branch" when it lives in a fork. */
export function headLabel(pr: Pick<PullRequestDetails, 'headRefName' | 'isCrossRepository' | 'headOwner'>): string {
  return pr.isCrossRepository && pr.headOwner ? `${pr.headOwner}:${pr.headRefName}` : pr.headRefName;
}

/** What posting needs (src/host/github.ts), for the commit that was reviewed. */
export function toPullRequest(pr: PullRequestDetails, reviewedHead: string): PullRequest {
  return { host: pr.host, owner: pr.owner, repo: pr.repo, number: pr.number, url: pr.url, headRefOid: reviewedHead, baseRefName: pr.baseRefName, state: pr.state, headRefName: pr.headRefName };
}

// ---- errors -----------------------------------------------------------------------------------

export type PrErrorKind =
  | 'ghNotInstalled'
  | 'ghAuth' // gh (or git through it) isn't logged in to the host, or its token can't be used there
  | 'notFound' // no such pull request
  | 'noAccess' // no such repository, or not one this login can see
  | 'noRemote' // a bare number, but the workspace's repo has no GitHub remote gh can use
  | 'network'
  | 'invalid' // gh answered with something Filos won't use
  | 'gitNotInstalled'
  | 'git' // a git step failed for another reason
  | 'disk'
  | 'empty' // the pull request changes nothing
  | 'timeout'
  | 'cancelled'
  | 'failed';

/** A failed step of the pull request flow. `message` is plain, bounded and safe to show anywhere. */
export class PrError extends Error {
  constructor(
    message: string,
    readonly kind: PrErrorKind,
    /** Raw stderr / problems, for the log and the error view's details (as text). */
    readonly detail?: string,
    /** The GitHub host, for "log in to <host>". */
    readonly host?: string,
  ) {
    super(message);
    this.name = 'PrError';
  }
}

const NETWORK = /error connecting to|could not resolve host|couldn't resolve host|dial tcp|i\/o timeout|network is unreachable|no route to host|connection refused|connection reset|connection timed out|failed to connect|tls handshake|ssl_connect|unable to access|early eof|rpc failed|the remote end hung up/i;
const GH_AUTH = /gh auth login|not logged in|not logged into|authentication required|HTTP 401|bad credentials|requires authentication/i;
const SSO = /SAML|single sign-on|SSO/;
const GIT_AUTH = /could not read (?:username|password)|authentication failed|terminal prompts disabled|permission denied \(publickey|access denied|invalid username or password|HTTP 403|returned error: 403/i;
const DISK = /no space left on device|disk quota exceeded/i;

const tail = (r: RunResult) => [r.stderrTail.trim(), r.stdout.trim()].filter(Boolean).join('\n').slice(-4000);

/** gh pr view / pr list failed: say why in words that fit a pull request lookup. */
export function lookupFailure(r: RunResult, ghPath: string, what: { label: string; host?: string; timeoutMs: number }): PrError {
  const stderr = r.stderrTail;
  const detail = tail(r);
  if (r.spawnError) {
    if (r.spawnError.code === 'ENOENT') return ghMissing(ghPath);
    return new PrError(`Filos couldn't start the GitHub CLI: ${safeProgressText(r.spawnError.message, 160)}`, 'failed', detail);
  }
  if (r.aborted) return new PrError('Cancelled.', 'cancelled');
  if (r.timedOut) return new PrError(`The GitHub CLI didn't answer within ${Math.round(what.timeoutMs / 1000)} seconds while looking up ${what.label}.`, 'timeout', detail);
  if (/could not resolve to a pull ?request/i.test(stderr)) return new PrError(`There's no pull request ${what.label} on GitHub.`, 'notFound', detail);
  if (SSO.test(stderr)) {
    return new PrError(`Your GitHub CLI login isn't authorised for this organisation's single sign-on. Run "gh auth refresh"${what.host ? ` for ${what.host}` : ''} and authorise it, then retry.`, 'ghAuth', detail, what.host);
  }
  // Before the login check: gh's "no GitHub remote" message also mentions `gh auth login`.
  if (/none of the git remotes|no git remotes|not a git repository/i.test(stderr)) {
    return new PrError("The workspace's repository has no GitHub remote. Enter the pull request's URL or owner/repo#number instead.", 'noRemote', detail);
  }
  if (r.exitCode === 4 || GH_AUTH.test(stderr)) {
    return new PrError(`The GitHub CLI is not logged in${what.host ? ` to ${what.host}` : ''}. Log in with "gh auth login", then retry.`, 'ghAuth', detail, what.host);
  }
  if (/could not resolve to a repository|HTTP 404|repository not found/i.test(stderr)) {
    return new PrError(`GitHub has no repository for ${what.label} that your GitHub CLI login can see. Check the name, or that your login can see private repositories ("gh auth status").`, 'noAccess', detail, what.host);
  }
  if (/set-default|no default remote/i.test(stderr)) {
    return new PrError('The workspace\'s repository has several remotes and the GitHub CLI doesn\'t know which one to use. Run "gh repo set-default" in it, or enter the pull request\'s URL.', 'noRemote', detail);
  }
  if (NETWORK.test(stderr)) return new PrError(`Filos couldn't reach ${what.host ?? 'GitHub'}. Check your connection (or VPN), then retry.`, 'network', detail, what.host);
  const e = ghFailure(r, `looking up ${what.label}`, ghPath, what.timeoutMs);
  return new PrError(e.message, 'failed', detail);
}

function ghMissing(ghPath: string): PrError {
  return new PrError(`Filos can't find the GitHub CLI ("${safeProgressText(ghPath, 120)}"). Install gh and run "gh auth login", or set "filos.gh.path".${offPathHint(ghPath, 'filos.gh.path')}`, 'ghNotInstalled');
}

/** A clone or fetch failed (git's stderr, maybe through gh). `what` reads after "while". */
export function transferFailure(stderr: string, what: string, pr: Pick<PullRequestDetails, 'host' | 'owner' | 'repo' | 'number' | 'baseRefName'>, detail = stderr): PrError {
  const name = `${pr.owner}/${pr.repo}`;
  // gh clones with git: on a Mac without Apple's Command Line Tools, git is only a stub.
  if (git.missingDeveloperTools(stderr)) return new PrError(git.DEVELOPER_TOOLS_MESSAGE, 'gitNotInstalled', detail);
  if (DISK.test(stderr)) return new PrError(`The disk is full, so Filos couldn't finish ${what}. Free some space (or run "Filos: Delete Pull Request Checkouts"), then retry.`, 'disk', detail);
  if (/couldn't find remote ref refs\/pull\//i.test(stderr)) return new PrError(`GitHub has no commits for ${prLabel(pr)} to fetch.`, 'notFound', detail);
  if (/couldn't find remote ref refs\/heads\//i.test(stderr)) {
    return new PrError(`The pull request's base branch, ${safeProgressText(pr.baseRefName, 80)}, no longer exists on GitHub, so there's nothing to compare it with.`, 'notFound', detail);
  }
  if (SSO.test(stderr)) return new PrError(`Your GitHub CLI login isn't authorised for this organisation's single sign-on, so git couldn't get ${name}. Run "gh auth refresh" and authorise it, then retry.`, 'ghAuth', detail, pr.host);
  if (/repository .*not found|repository not found|does not exist/i.test(stderr) && !NETWORK.test(stderr)) {
    return new PrError(`git couldn't find ${name} on ${pr.host}. Check that your GitHub CLI login can see it ("gh auth status").`, 'noAccess', detail, pr.host);
  }
  if (GIT_AUTH.test(stderr) || GH_AUTH.test(stderr)) {
    return new PrError(`git couldn't log in to ${pr.host} while ${what}. Log in with "gh auth login" (for SSH remotes, check your SSH key), then retry.`, 'ghAuth', detail, pr.host);
  }
  if (NETWORK.test(stderr)) return new PrError(`Filos couldn't reach ${pr.host} while ${what}. Check your connection (or VPN), then retry.`, 'network', detail, pr.host);
  const line = stderr.split('\n').map((l) => l.trim()).find((l) => /^(?:fatal|error):/i.test(l)) ?? stderr.split('\n').find((l) => l.trim()) ?? '';
  return new PrError(`git failed while ${what}${line ? `: ${safeProgressText(line, 200)}` : '.'}`, 'git', detail);
}

/** A GitError from one of our git calls, as a PrError. */
function gitFailure(e: unknown, what: string, pr: PullRequestDetails): PrError {
  if (e instanceof PrError) return e;
  if (e instanceof git.GitError) {
    if (e.code === git.ABORTED) return new PrError('Cancelled.', 'cancelled');
    if (e.code === git.TIMED_OUT) return new PrError(`${e.message}, while ${what}. A very large repository can take longer: retry.`, 'timeout', e.stderr);
    if (e.code === git.GIT_NOT_FOUND) return new PrError(git.missingDeveloperTools(e.stderr) ? git.DEVELOPER_TOOLS_MESSAGE : 'Filos can\'t find git. Install it (and make sure it is on PATH), then retry.', 'gitNotInstalled', e.stderr || undefined);
    if (e.code === git.OUTPUT_TOO_LARGE) return new PrError(safeProgressText(e.message, 300), 'failed');
    return transferFailure(e.stderr || e.message, what, pr, e.stderr || e.message);
  }
  return new PrError(`Something went wrong while ${what}: ${safeProgressText(e instanceof Error ? e.message : String(e), 200)}`, 'failed');
}

// ---- gh calls ---------------------------------------------------------------------------------

export interface PrGhOptions {
  /** A name on PATH or an absolute path (the user-only setting filos.gh.path). */
  gh: string;
  /**
   * Where gh runs. A bare number is resolved against this repository's remotes; for a URL or
   * owner/repo#n it should be a neutral folder (Filos's storage), so gh reads no workspace config.
   */
  cwd: string;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  timeoutMs?: number;
}

const LOOKUP_TIMEOUT_MS = 60_000;

/** The pull request's details, checked. Rejects with a PrError. */
export async function viewPullRequest(o: PrGhOptions, input: PullRequestInput): Promise<PullRequestDetails> {
  const selector =
    input.kind === 'url' ? [input.url] : input.kind === 'repo' ? [String(input.number), '--repo', `${input.owner}/${input.repo}`] : [String(input.number)];
  const host = input.kind === 'url' ? input.host : undefined;
  const label = input.kind === 'number' ? `#${input.number} in the workspace's repository` : describeInput(input);
  const timeoutMs = o.timeoutMs ?? LOOKUP_TIMEOUT_MS;
  let fields = PR_DETAIL_FIELDS.split(',');
  let r: RunResult;
  for (;;) {
    r = await runProcess({
      command: o.gh,
      args: ['pr', 'view', ...selector, '--json', fields.join(',')],
      cwd: o.cwd,
      // A URL names its host: a GH_HOST/GH_REPO meant for another server must not redirect it.
      env: ghEnv(o.env, { explicit: input.kind === 'url' }),
      signal: o.signal,
      timeoutMs,
      collectStdout: true,
      maxCollectBytes: 4 * 1024 * 1024,
      maxStdoutBytes: 8 * 1024 * 1024,
    });
    // gh checks the field names before it asks GitHub anything, so asking again costs nothing.
    const unknown = r.exitCode === 1 ? /Unknown JSON field: "([A-Za-z]+)"/.exec(r.stderrTail)?.[1] : undefined;
    if (unknown && OPTIONAL_DETAIL_FIELDS.has(unknown) && fields.includes(unknown)) {
      fields = fields.filter((f) => f !== unknown);
      continue;
    }
    break;
  }
  if (r.exitCode !== 0 || r.spawnError || r.aborted || r.timedOut || r.overflow) throw lookupFailure(r, o.gh, { label, host, timeoutMs });
  let raw: unknown;
  try {
    raw = JSON.parse(r.stdout);
  } catch {
    throw new PrError("The GitHub CLI's answer about the pull request isn't JSON, so Filos stopped.", 'invalid', r.stdout.slice(0, 2000));
  }
  const checked = pullRequestDetailsFromView(raw);
  if (!checked.ok) throw new PrError("The GitHub CLI's answer about the pull request doesn't look right, so Filos stopped.", 'invalid', checked.problems.join('\n'));
  const pr = checked.pr;
  // gh answers for the URL it was given (or the repo's remote); anything else is a mix-up.
  if (pr.number !== input.number) throw new PrError(`GitHub answered with #${pr.number}, not #${input.number}, so Filos stopped.`, 'invalid');
  if (input.kind === 'url' && pr.host !== input.host) throw new PrError(`GitHub answered from ${pr.host}, not ${input.host}, so Filos stopped.`, 'invalid');
  return pr;
}

export interface PullRequestListItem {
  number: number;
  url: string;
  title: string;
  author?: string;
  headRefName: string;
  baseRefName: string;
  isDraft: boolean;
  updatedAt?: string;
  additions?: number;
  deletions?: number;
}

/** Open pull requests of the repository at o.cwd, newest first, as gh lists them. Rejects with a PrError. */
export async function listPullRequests(o: PrGhOptions, limit = 50): Promise<PullRequestListItem[]> {
  const timeoutMs = o.timeoutMs ?? LOOKUP_TIMEOUT_MS;
  const r = await runProcess({
    command: o.gh,
    args: ['pr', 'list', '--json', PR_LIST_FIELDS, '--limit', String(limit)],
    cwd: o.cwd,
    env: ghEnv(o.env),
    signal: o.signal,
    timeoutMs,
    collectStdout: true,
    maxCollectBytes: 4 * 1024 * 1024,
    maxStdoutBytes: 8 * 1024 * 1024,
  });
  if (r.exitCode !== 0 || r.spawnError || r.aborted || r.timedOut || r.overflow) throw lookupFailure(r, o.gh, { label: "the workspace repository's pull requests", timeoutMs });
  let raw: unknown;
  try {
    raw = JSON.parse(r.stdout);
  } catch {
    throw new PrError("The GitHub CLI's list of pull requests isn't JSON.", 'invalid', r.stdout.slice(0, 2000));
  }
  return parsePullRequestList(raw).slice(0, limit);
}

/** Items that don't check out are left out rather than shown. */
export function parsePullRequestList(raw: unknown): PullRequestListItem[] {
  if (!Array.isArray(raw)) return [];
  const out: PullRequestListItem[] = [];
  for (const v of raw as Record<string, unknown>[]) {
    if (!v || typeof v !== 'object') continue;
    const where = typeof v.url === 'string' ? parsePullRequestUrl(v.url) : undefined;
    if (!where || where.number !== v.number || typeof v.title !== 'string') continue;
    const item: PullRequestListItem = {
      number: where.number,
      url: v.url as string,
      title: cleanLine(v.title, MAX_TITLE),
      headRefName: isSafeBranchName(v.headRefName) ? v.headRefName : '?',
      baseRefName: isSafeBranchName(v.baseRefName) ? v.baseRefName : '?',
      isDraft: v.isDraft === true,
    };
    const author = login(v.author);
    if (author) item.author = author;
    if (typeof v.updatedAt === 'string' && !Number.isNaN(Date.parse(v.updatedAt))) item.updatedAt = v.updatedAt;
    const add = count(v.additions);
    const del = count(v.deletions);
    if (add !== undefined) item.additions = add;
    if (del !== undefined) item.deletions = del;
    out.push(item);
  }
  return out;
}

// ---- the code ---------------------------------------------------------------------------------

export interface CheckoutPaths {
  /** <root>/<host>/<owner>/<repo>, lower-cased (GitHub names are case-insensitive). Holds the clone's lock. */
  base: string;
  /** The blobless clone. */
  repoDir: string;
  /** Where this repository's PR worktrees go. */
  worktrees: string;
  /** Leases on worktrees, one file per window reviewing one (checkoutLocks.ts). */
  leases: string;
}

/** Throws for names that aren't safe path parts (they were checked already; this is the last line). */
export function checkoutPaths(root: string, pr: Pick<PullRequestDetails, 'host' | 'owner' | 'repo'>): CheckoutPaths {
  const host = pr.host.toLowerCase();
  if (!HOST.test(host) || !validOwner(pr.owner) || !validRepo(pr.repo)) throw new PrError('The pull request details look wrong, so Filos stopped.', 'invalid');
  // A port's ":" isn't allowed in a Windows path.
  const base = join(resolve(root), host.replace(':', '_'), pr.owner.toLowerCase(), pr.repo.toLowerCase());
  if (!base.startsWith(resolve(root) + sep)) throw new PrError('The pull request details look wrong, so Filos stopped.', 'invalid');
  return { base, repoDir: join(base, 'repo'), worktrees: join(base, 'worktrees'), leases: join(base, 'leases') };
}

/** A directory name for a PR head: pr-<n>-<first 12 hex digits>. */
export function worktreeName(n: number, oid: string): string {
  return `pr-${n}-${oid.slice(0, 12)}`;
}

/** Hooks look in here, and it never exists. */
function noHooksPath(root: string): string {
  return process.platform === 'win32' ? join(resolve(root), '.no-hooks') : '/dev/null';
}

/** Quoted for the POSIX shell git runs credential helpers with (Git for Windows ships one too). */
export function shQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * Global options for every git call in these clones: hooks never run, symlinks are plain files,
 * submodules are left alone, and HTTPS logins go through `gh auth git-credential` (what `gh auth
 * setup-git` would configure), so a private repository fetches with the user's gh login while
 * Filos never sees a token.
 */
export function cloneGitConfig(root: string, ghPath: string): string[] {
  const gh = resolveCommand(ghPath) ?? ghPath;
  return [
    '-c', `core.hooksPath=${noHooksPath(root)}`,
    '-c', 'core.symlinks=false',
    '-c', 'submodule.recurse=false',
    '-c', 'fetch.recurseSubmodules=false',
    '-c', 'credential.helper=',
    '-c', `credential.helper=!${shQuote(gh)} auth git-credential`,
    '-c', 'advice.detachedHead=false',
  ];
}

/** The environment for git in these clones: no prompts, and LFS files stay pointers (no downloads on checkout). */
function cloneEnv(env: NodeJS.ProcessEnv | undefined): NodeJS.ProcessEnv {
  return { ...(env ?? process.env), GIT_TERMINAL_PROMPT: '0', GIT_LFS_SKIP_SMUDGE: '1', GCM_INTERACTIVE: 'never' };
}

export interface CheckoutOptions {
  gh: string;
  /** Filos's storage for pull requests: <globalStorage>/prs. */
  root: string;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  /** "cloning acme/ledger", "fetching #9", "checking out 1a2b3c4", "waiting for another VS Code window…". */
  onProgress?: (stage: 'wait' | 'clone' | 'fetch' | 'checkout', text: string) => void;
  /** Tidying that failed without failing the review (an older checkout that couldn't be removed). */
  log?: (message: string) => void;
  cloneTimeoutMs?: number;
  fetchTimeoutMs?: number;
}

export interface PullRequestCheckout {
  repoDir: string;
  /** Real path of the worktree with the PR head checked out: the review's repo root. */
  worktree: string;
  /** The commit under review (the fetched head). */
  headOid: string;
  /** The base as compared with: the branch's tip for an open PR; where it was for a closed or merged one. */
  baseOid: string;
  mergeBase: string;
  /** The dependency index as of the merge base: the PR's own copy (in the worktree) is the author's to write. */
  dependencyIndex: DependencyIndexRead;
  /** git options for any further call in this clone (cloneGitConfig). */
  config: string[];
  env: NodeJS.ProcessEnv;
  /** The clone was made by this call (else an earlier one was reused). */
  cloned: boolean;
  /** The worktree for this head existed already and was clean. */
  reusedWorktree: boolean;
  warnings: string[];
  /**
   * This window's lease on the worktree: other windows leave it alone until it is released. Release
   * it when the review of it ends (or if it never starts).
   */
  lease: Held;
  paths: CheckoutPaths;
}

const CLONE_TIMEOUT_MS = 30 * 60_000;
const FETCH_TIMEOUT_MS = 15 * 60_000;
/** Reading the dependency index may fetch its blob. */
const INDEX_TIMEOUT_MS = 2 * 60_000;

/**
 * One prepare at a time per clone in this window: concurrent ones (two PRs of one repo) would race
 * on its refs and worktrees. Other windows are kept out by the clone's lock (checkoutLocks.ts).
 */
const queues = new Map<string, Promise<unknown>>();

function serialised<T>(key: string, run: () => Promise<T>): Promise<T> {
  const before = queues.get(key) ?? Promise.resolve();
  const p = before.then(run, run);
  const settled = p.then(
    () => undefined,
    () => undefined,
  );
  queues.set(key, settled);
  void settled.then(() => {
    if (queues.get(key) === settled) queues.delete(key);
  });
  return p;
}

/** Resolves once every prepare (and diff) running under `root` in this window has finished (for cleanup). */
export async function checkoutsIdle(root: string): Promise<void> {
  const prefix = resolve(root) + sep;
  await Promise.all([...queues].filter(([k]) => k.startsWith(prefix)).map(([, p]) => p));
}

/** This window's queue, then the clone's lock (other windows), then `run`. */
function exclusive<T>(paths: CheckoutPaths, pr: PullRequestDetails, o: Pick<CheckoutOptions, 'signal' | 'onProgress'>, run: () => Promise<T>): Promise<T> {
  return serialised(paths.repoDir, async () => {
    if (o.signal?.aborted) throw new PrError('Cancelled.', 'cancelled');
    let held: Held;
    try {
      held = await acquireLock(paths.base, { signal: o.signal, onWait: (who) => o.onProgress?.('wait', `waiting for ${who}, which is getting ${pr.owner}/${pr.repo}`) });
    } catch (e) {
      if (o.signal?.aborted) throw new PrError('Cancelled.', 'cancelled');
      throw fsFailure(e, `getting ${pr.owner}/${pr.repo} ready`, paths.base);
    }
    try {
      return await run();
    } finally {
      held.release();
    }
  });
}

/** Makes Filos's pull request storage; a failure reads as what it is (a full disk, say), not as a bug. */
export function ensureStorage(root: string): void {
  fsStep('preparing its storage for pull requests', root, () => mkdirSync(root, { recursive: true }));
}

/**
 * The PR's head checked out in a worktree of Filos's own clone, its base fetched, and their merge
 * base. Clones once per repository, then fetches. Rejects with a PrError.
 */
export function prepareCheckout(pr: PullRequestDetails, o: CheckoutOptions): Promise<PullRequestCheckout> {
  const paths = checkoutPaths(o.root, pr);
  return exclusive(paths, pr, o, () => prepare(pr, paths, o));
}

/** Whether `e` is a cancellation (which must stop the work, never be read as "not reusable"). */
function isCancel(e: unknown, signal?: AbortSignal): boolean {
  return !!signal?.aborted || (e instanceof PrError && e.kind === 'cancelled');
}

/** A step whose failure doesn't matter, except a cancellation. */
async function quiet(p: Promise<string>, signal?: AbortSignal): Promise<string | undefined> {
  try {
    return await p;
  } catch (e) {
    if (isCancel(e, signal)) throw new PrError('Cancelled.', 'cancelled');
    return undefined;
  }
}

async function prepare(pr: PullRequestDetails, paths: CheckoutPaths, o: CheckoutOptions): Promise<PullRequestCheckout> {
  if (o.signal?.aborted) throw new PrError('Cancelled.', 'cancelled');
  const config = cloneGitConfig(o.root, o.gh);
  const env = cloneEnv(o.env);
  const warnings: string[] = [];
  const run: Run = (cwd, args, what, extra = {}) =>
    git.git(cwd, args, { config, env, signal: o.signal, ...extra }).catch((e: unknown) => {
      throw gitFailure(e, what, pr);
    });

  fsStep(`getting ${pr.owner}/${pr.repo}`, paths.base, () => mkdirSync(paths.base, { recursive: true }));
  let cloned = false;
  const clone = await cloneState(paths.repoDir, pr, config, env);
  if (clone.kind !== 'ok') {
    if (clone.kind === 'other' && clone.origin) {
      // Not a clone of this repository (GH_HOST once sent `gh repo clone` to another server, say):
      // fetching the PR there would bring another server's code under this PR's name.
      warnings.push(`Filos's earlier copy of ${pr.owner}/${pr.repo} came from ${safeProgressText(clone.origin, 120)}, not ${pr.host}, so it was cloned again.`);
    }
    if (existsSync(paths.repoDir)) await removeTree(paths.repoDir, `replacing Filos's copy of ${pr.owner}/${pr.repo}`);
    o.onProgress?.('clone', `cloning ${pr.owner}/${pr.repo}`);
    await cloneInto(pr, paths, o);
    cloned = true;
  }

  o.onProgress?.('fetch', `fetching #${pr.number}`);
  const headRef = `refs/filos/pr/${pr.number}/head`;
  const baseRef = `refs/filos/pr/${pr.number}/base`;
  const fetch = (refspecs: string[]) =>
    run(paths.repoDir, ['fetch', '--quiet', '--no-tags', '--no-recurse-submodules', 'origin', ...refspecs], `fetching ${prLabel(pr)}`, { timeoutMs: o.fetchTimeoutMs ?? FETCH_TIMEOUT_MS });
  // refs/pull/<n>/head lives in the base repository, so a PR from a fork fetches like any other.
  const head = `+refs/pull/${pr.number}/head:${headRef}`;
  const branch = `+refs/heads/${pr.baseRefName}:${baseRef}`;
  const base = baseSource(pr);
  if (base.kind === 'branch') {
    await fetch([head, branch]);
    // After a merge the branch contains the head, so the diff may well come out empty.
    if (pr.state === 'MERGED') warnings.push(`GitHub didn't say where this merged pull request's base was, so it is compared with ${safeProgressText(pr.baseRefName, 80)} as it is now.`);
  } else {
    // A closed or merged PR is compared with its base as it was, not with the branch now: after a
    // merge, the branch contains the head, and the diff from their merge base would be empty. A
    // commit is fetched by its id (GitHub serves reachable commits), so a deleted branch is fine too.
    const ref = base.kind === 'merge' ? `refs/filos/pr/${pr.number}/merge` : baseRef;
    try {
      await fetch([head, `+${base.oid}:${ref}`]);
      if (base.kind === 'merge') {
        // The merge commit's first parent is the base just before the merge (or squash).
        const parent = (await run(paths.repoDir, ['rev-parse', '--verify', '--quiet', `${ref}^1^{commit}`], 'reading the base before the merge')).trim();
        if (!OID.test(parent)) throw new PrError("git couldn't read the commit before the merge, so Filos stopped.", 'git');
        await run(paths.repoDir, ['update-ref', baseRef, parent], 'recording the base before the merge');
      }
    } catch (e) {
      if (isCancel(e, o.signal) || !(e instanceof PrError) || (e.kind !== 'git' && e.kind !== 'notFound')) throw e;
      // The commit is gone from GitHub (or the merge commit has no parent): the branch is all there is.
      await fetch([head, branch]);
      warnings.push(`GitHub no longer has the base this ${pr.state === 'MERGED' ? 'merged' : 'closed'} pull request had, so it is compared with ${safeProgressText(pr.baseRefName, 80)} as it is now.`);
    }
  }
  const headOid = (await run(paths.repoDir, ['rev-parse', '--verify', '--quiet', `${headRef}^{commit}`], 'reading the fetched head')).trim();
  const baseOid = (await run(paths.repoDir, ['rev-parse', '--verify', '--quiet', `${baseRef}^{commit}`], 'reading the fetched base')).trim();
  if (!OID.test(headOid) || !OID.test(baseOid)) throw new PrError('git fetched something that isn\'t a commit, so Filos stopped.', 'invalid', `head ${headOid}\nbase ${baseOid}`);
  if (headOid !== pr.headRefOid) {
    warnings.push(`The pull request moved while Filos fetched it: GitHub said its head was ${pr.headRefOid.slice(0, 7)}, and the fetch brought ${headOid.slice(0, 7)}. This review is of ${headOid.slice(0, 7)}.`);
  }

  const mergeBase = await git.git(paths.repoDir, ['merge-base', baseRef, headOid], { config, env, signal: o.signal, timeoutMs: o.fetchTimeoutMs ?? FETCH_TIMEOUT_MS }).then(
    (out) => out.trim(),
    (e: unknown) => {
      // merge-base exits 1, saying nothing, when there's no common history.
      if (e instanceof git.GitError && e.code === 1 && !e.stderr.trim()) return '';
      throw gitFailure(e, 'finding where the pull request branched off', pr);
    },
  );
  if (!OID.test(mergeBase)) {
    throw new PrError(`The pull request's head and ${safeProgressText(pr.baseRefName, 80)} have no common history, so there's nothing to compare.`, 'git');
  }
  const dependencyIndex = await dependencyIndexAt(paths.repoDir, mergeBase, { config, env, signal: o.signal });

  o.onProgress?.('checkout', `checking out ${headOid.slice(0, 7)}`);
  const { worktree, reused } = await checkoutWorktree(pr, paths, headOid, run, o);
  // Last, so a failure above leaves no lease behind.
  const lease = fsStep('marking the checkout as in use', paths.leases, () => takeLease(paths.leases, basename(worktree)));
  return { repoDir: paths.repoDir, worktree, headOid, baseOid, mergeBase, dependencyIndex, config, env, cloned, reusedWorktree: reused, warnings, lease, paths };
}

type BaseSource = { kind: 'branch' } | { kind: 'oid'; oid: string } | { kind: 'merge'; oid: string };

/**
 * What a PR's diff is computed against. Open: the base branch's tip, as GitHub does. Closed or
 * merged: where the base was (baseRefOid), else, for a merged PR, the merge commit's first parent
 * (an older gh, 2.45 for one, has no baseRefOid). A merge commit that is the head itself (a fast-forward push)
 * has the PR's own last commit as its parent, so it can't say. Failing all that, the branch.
 */
export function baseSource(pr: Pick<PullRequestDetails, 'state' | 'baseRefOid' | 'mergeCommitOid' | 'headRefOid'>): BaseSource {
  if (pr.state === 'OPEN') return { kind: 'branch' };
  if (pr.baseRefOid) return { kind: 'oid', oid: pr.baseRefOid };
  if (pr.state === 'MERGED' && pr.mergeCommitOid && pr.mergeCommitOid !== pr.headRefOid) return { kind: 'merge', oid: pr.mergeCommitOid };
  return { kind: 'branch' };
}

/**
 * The dependency index from the merge base. The worktree's copy is the PR head's: whatever the
 * author committed (an index that says the riskiest symbol has no consumers, say). Read like the
 * file on disk would be: a regular file at .filos/dependency-index.json (no symlink, no submodule),
 * within the size cap. Failures are warnings: the review goes on without an index.
 */
export async function dependencyIndexAt(repoDir: string, commit: string, g: git.GitOptions): Promise<DependencyIndexRead> {
  const path = DEP_INDEX.split(sep).join('/');
  const ignored = (reason: string): DependencyIndexRead => ({ warning: `Dependency index ignored: ${reason}` });
  try {
    // Without -l: the size would need the blob, which a blobless clone fetches on the spot.
    const listed = await git.git(repoDir, ['ls-tree', '-z', commit, '--', path], g);
    const m = /^(\d{6}) (\w+) ([0-9a-f]{40}|[0-9a-f]{64})\t/.exec(listed);
    if (!m) return {};
    const [, mode, type, oid] = m;
    if (type !== 'blob' || (mode !== '100644' && mode !== '100755')) return ignored(`${path} is not a regular file where the pull request branched off.`);
    // This fetches the blob (bounded by the timeout); more than the cap stops git.
    return { text: await git.git(repoDir, ['cat-file', 'blob', oid], { ...g, timeoutMs: INDEX_TIMEOUT_MS, maxBuffer: MAX_DEP_INDEX_BYTES }) };
  } catch (e) {
    if (g.signal?.aborted || (e instanceof git.GitError && e.code === git.ABORTED)) throw new PrError('Cancelled.', 'cancelled');
    if (e instanceof git.GitError && e.code === git.OUTPUT_TOO_LARGE) return ignored(`${path} is over the ${MAX_DEP_INDEX_BYTES / 1024 / 1024} MB limit.`);
    return ignored(`Filos couldn't read ${path} from where the pull request branched off (${safeProgressText(e instanceof Error ? e.message : String(e), 160)}).`);
  }
}

/** 'other': something to replace, never fetch into; `origin` when it is a clone of another repository or server. */
type CloneState = { kind: 'ok' } | { kind: 'missing' } | { kind: 'other'; origin?: string };

/** A clone Filos made before and can reuse: a git dir whose origin is this PR's repository on its host. */
async function cloneState(dir: string, pr: Pick<PullRequestDetails, 'host' | 'owner' | 'repo'>, config: string[], env: NodeJS.ProcessEnv): Promise<CloneState> {
  if (!existsSync(join(dir, '.git'))) return existsSync(dir) ? { kind: 'other' } : { kind: 'missing' };
  let url = '';
  try {
    url = (await git.git(dir, ['config', '--get', 'remote.origin.url'], { config, env })).trim();
  } catch {
    // no origin, or not a repository any more
  }
  if (!url) return { kind: 'other' };
  return originMatches(url, pr) ? { kind: 'ok' } : { kind: 'other', origin: normaliseOriginUrl(url) ?? url };
}

/** Whether a remote URL (https, ssh or scp-like) names this repository on this host (the port aside). */
export function originMatches(url: string, pr: Pick<PullRequestDetails, 'host' | 'owner' | 'repo'>): boolean {
  const want = `${pr.host.replace(/:\d+$/, '')}/${pr.owner}/${pr.repo}`.toLowerCase();
  return normaliseOriginUrl(url) === want;
}

/**
 * `gh repo clone` into a scratch directory, moved into place when complete, so a clone that fails
 * or is interrupted never looks reusable. Hooks and symlinks are off in the clone's own config too,
 * so even git commands Filos doesn't run (an editor's git integration) don't run the PR's hooks.
 * The host is always named, github.com included: gh would otherwise clone from GH_HOST when the
 * environment sets one (common for GitHub Enterprise users), i.e. another server's repository.
 */
async function cloneInto(pr: PullRequestDetails, paths: CheckoutPaths, o: CheckoutOptions): Promise<void> {
  const scratch = join(paths.base, `.clone-${randomBytes(4).toString('hex')}`);
  const env = { ...ghEnv(cloneEnv(o.env), { explicit: true }), GH_HOST: pr.host };
  const timeoutMs = o.cloneTimeoutMs ?? CLONE_TIMEOUT_MS;
  try {
    const r = await runProcess({
      command: o.gh,
      args: ['repo', 'clone', `${pr.host}/${pr.owner}/${pr.repo}`, scratch, '--', '--filter=blob:none', '--no-checkout', '--config', `core.hooksPath=${noHooksPath(o.root)}`, '--config', 'core.symlinks=false'],
      cwd: paths.base,
      env,
      signal: o.signal,
      timeoutMs,
      collectStdout: true,
      maxCollectBytes: 256 * 1024,
      stderrTailBytes: 16 * 1024,
    });
    if (r.spawnError?.code === 'ENOENT') throw ghMissing(o.gh);
    if (r.aborted) throw new PrError('Cancelled.', 'cancelled');
    if (r.timedOut) throw new PrError(`Cloning ${pr.owner}/${pr.repo} didn't finish within ${Math.round(timeoutMs / 60_000)} minutes. Retry; the next try starts over.`, 'timeout', tail(r));
    if (r.spawnError || r.exitCode !== 0 || !existsSync(join(scratch, '.git'))) {
      if (r.exitCode === 4) throw new PrError(`The GitHub CLI is not logged in to ${pr.host}. Log in with "gh auth login", then retry.`, 'ghAuth', tail(r), pr.host);
      throw transferFailure(r.stderrTail || r.spawnError?.message || '', `cloning ${pr.owner}/${pr.repo}`, pr, tail(r));
    }
    // An existing clone is never deleted here (another window may be using it); the lock means
    // none should have appeared, but if one did, it stays and this one goes.
    if (!existsSync(paths.repoDir)) fsStep(`cloning ${pr.owner}/${pr.repo}`, paths.repoDir, () => renameSync(scratch, paths.repoDir));
  } finally {
    await removeTree(scratch, `cloning ${pr.owner}/${pr.repo}`).catch(() => undefined);
  }
}

type Run = (cwd: string, args: string[], what: string, extra?: git.GitOptions) => Promise<string>;

/**
 * A detached worktree at the head: reused when it is already there, at that commit and clean;
 * otherwise (re)made. Older worktrees of the same PR are removed, so a PR that moved doesn't pile
 * up, unless another window is reviewing them.
 */
async function checkoutWorktree(pr: PullRequestDetails, paths: CheckoutPaths, headOid: string, run: Run, o: CheckoutOptions): Promise<{ worktree: string; reused: boolean }> {
  const wt = join(paths.worktrees, worktreeName(pr.number, headOid));
  let reused = false;
  if (existsSync(join(wt, '.git'))) {
    // A cancellation stops here: it says nothing about the checkout, which must not be thrown away for it.
    const at = await quiet(run(wt, ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}'], 'checking the existing checkout'), o.signal);
    const dirty = at?.trim() === headOid ? await quiet(run(wt, ['status', '--porcelain', '--untracked-files=normal'], 'checking the existing checkout'), o.signal) : undefined;
    reused = at?.trim() === headOid && dirty !== undefined && !dirty.trim();
  }
  if (!reused) {
    if (o.signal?.aborted) throw new PrError('Cancelled.', 'cancelled');
    await removeWorktree(paths, wt, run, o.signal);
    await quiet(run(paths.repoDir, ['worktree', 'prune'], 'tidying old checkouts'), o.signal);
    fsStep(`checking out ${prLabel(pr)}`, paths.worktrees, () => mkdirSync(paths.worktrees, { recursive: true }));
    // Checking out downloads the head's files (the clone is blobless): it can take a while. -f -f:
    // an entry a hard-killed `worktree add` left locked ("initializing") would refuse a single -f.
    await run(paths.repoDir, ['worktree', 'add', '--detach', '-f', '-f', wt, headOid], `checking out ${prLabel(pr)}`, { timeoutMs: o.fetchTimeoutMs ?? FETCH_TIMEOUT_MS });
  }
  await removeOlderWorktrees(pr.number, paths, wt, run, o);
  return { worktree: fsStep(`checking out ${prLabel(pr)}`, wt, () => realpathSync(wt)), reused };
}

/**
 * Removes one of Filos's worktrees, locked or not: an entry left locked ("initializing") by a
 * `worktree add` that was killed refuses a plain `remove --force`, and `worktree prune` keeps it.
 * Throws a PrError when the folder can't be removed.
 */
async function removeWorktree(paths: CheckoutPaths, wt: string, run: Run, signal?: AbortSignal): Promise<void> {
  await quiet(run(paths.repoDir, ['worktree', 'unlock', wt], 'unlocking an old checkout'), signal);
  await quiet(run(paths.repoDir, ['worktree', 'remove', '-f', '-f', wt], 'removing an old checkout'), signal);
  await removeTree(wt, 'removing an old checkout');
}

async function removeOlderWorktrees(n: number, paths: CheckoutPaths, keep: string, run: Run, o: CheckoutOptions): Promise<void> {
  const mine = new RegExp(`^pr-${n}-[0-9a-f]{12}$`);
  const stale = new Set<string>();
  const listed = (await quiet(run(paths.repoDir, ['worktree', 'list', '--porcelain'], 'listing checkouts'), o.signal)) ?? '';
  for (const line of listed.split('\n')) {
    if (!line.startsWith('worktree ')) continue;
    const p = line.slice('worktree '.length).trim();
    if (mine.test(basename(p)) && sameDir(dirname(p), paths.worktrees) && !sameDir(p, keep)) stale.add(p);
  }
  // Directories left by a crash (not registered any more) go too.
  try {
    for (const e of readdirSync(paths.worktrees)) if (mine.test(e) && !sameDir(join(paths.worktrees, e), keep)) stale.add(join(paths.worktrees, e));
  } catch {
    // no worktrees dir: nothing to tidy
  }
  if (!stale.size) return;
  for (const p of stale) {
    // Another window is reviewing it: its code pane and agent calls read from there.
    if (leasesElsewhere(paths.leases, basename(p))) {
      o.log?.(`kept ${p}: another VS Code window is reviewing it`);
      continue;
    }
    try {
      await removeWorktree(paths, p, run, o.signal);
    } catch (e) {
      // Tidying only: a file held open there (an editor, a virus scanner) mustn't fail this review.
      if (isCancel(e, o.signal)) throw e;
      o.log?.(`couldn't remove the older checkout ${p}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  await quiet(run(paths.repoDir, ['worktree', 'prune'], 'tidying old checkouts'), o.signal);
}

function sameDir(a: string, b: string): boolean {
  const norm = (p: string) => {
    let r = resolve(p);
    try {
      r = realpathSync(r);
    } catch {
      // gone already: compare as given
    }
    return process.platform === 'win32' || process.platform === 'darwin' ? r.toLowerCase() : r;
  };
  return norm(a) === norm(b);
}

/**
 * A file-system failure in getting the code, as a PrError that says what it is: a full disk, a
 * folder Filos may not write to, or one held open by another program. Node's own message (with the
 * path) goes in the detail.
 */
export function fsFailure(e: unknown, what: string, path: string): PrError {
  if (e instanceof PrError) return e;
  const err = e as NodeJS.ErrnoException;
  const detail = e instanceof Error ? (e.stack ?? e.message) : String(e);
  const where = safeProgressText(path, 200);
  switch (err?.code) {
    case 'ENOSPC':
    case 'EDQUOT':
      return new PrError(`The disk is full, so Filos couldn't finish ${what}. Free some space (or run "Filos: Delete Pull Request Checkouts"), then retry.`, 'disk', detail);
    case 'EACCES':
    case 'EPERM':
      return new PrError(`Filos isn't allowed to change ${where}, so it couldn't finish ${what}. A virus scanner can briefly hold new files: retry. If it keeps failing, check that folder's permissions.`, 'failed', detail);
    case 'EBUSY':
    case 'ENOTEMPTY':
      return new PrError(`${where} is in use by another program, so Filos couldn't finish ${what}. Close what has files open there, then retry.`, 'failed', detail);
    case 'EROFS':
      return new PrError(`${where} is on a read-only disk, so Filos couldn't finish ${what}.`, 'failed', detail);
    default:
      return new PrError(`Filos couldn't finish ${what}: ${safeProgressText(err?.message ?? String(e), 200)}`, 'failed', detail);
  }
}

/** Runs a synchronous file-system step, its failure as a PrError (fsFailure). */
function fsStep<T>(what: string, path: string, step: () => T): T {
  try {
    return step();
  } catch (e) {
    throw fsFailure(e, what, path);
  }
}

/** Deletes a tree off the extension host's thread (a big checkout takes a while), its failure as a PrError. */
async function removeTree(path: string, what: string): Promise<void> {
  try {
    await rm(path, { recursive: true, force: true, maxRetries: 3 });
  } catch (e) {
    throw fsFailure(e, what, path);
  }
}

/**
 * The PR's diff: merge base to head, shaped as GitHub shapes it (git.diff). Run in the clone, which
 * has no checkout: on git before 2.40 (no --attr-source) the head's .gitattributes then can't hide
 * changes. It may fetch blobs, so it holds the clone (exclusive). Rejects with a PrError.
 */
export function pullRequestDiff(pr: PullRequestDetails, c: PullRequestCheckout, signal?: AbortSignal): Promise<string> {
  return exclusive(c.paths, pr, { signal }, async () => {
    try {
      return await git.diff(c.repoDir, c.mergeBase, c.headOid, { config: c.config, env: c.env, signal, timeoutMs: FETCH_TIMEOUT_MS });
    } catch (e) {
      throw gitFailure(e, 'computing the diff', pr);
    }
  });
}

/**
 * "Delete Pull Request Checkouts": every clone and worktree under `root`, except what another window
 * is using right now (it holds the clone's lock, or a lease on one of its worktrees): those
 * repositories are kept whole, and listed. Wait for checkoutsIdle(root) first.
 */
export async function deleteCheckouts(root: string): Promise<{ kept: string[] }> {
  const kept: string[] = [];
  const dirs = (p: string) => {
    try {
      return readdirSync(p, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
    } catch {
      return [];
    }
  };
  for (const host of dirs(root)) {
    for (const owner of dirs(join(root, host))) {
      for (const repo of dirs(join(root, host, owner))) {
        const base = join(root, host, owner, repo);
        const label = `${host.replace('_', ':')}/${owner}/${repo}`;
        let held: Held | undefined;
        try {
          held = await tryLock(base);
        } catch (e) {
          throw fsFailure(e, 'deleting pull request checkouts', base);
        }
        if (!held || leasesElsewhere(join(base, 'leases'))) {
          held?.release();
          kept.push(label);
          continue;
        }
        try {
          await removeTree(base, 'deleting pull request checkouts');
        } finally {
          held.release();
        }
      }
    }
  }
  if (!kept.length) await removeTree(root, 'deleting pull request checkouts');
  else {
    // Empty owner and host folders of what was deleted.
    for (const host of dirs(root)) {
      for (const owner of dirs(join(root, host))) if (!dirs(join(root, host, owner)).length) await removeTree(join(root, host, owner), 'deleting pull request checkouts');
      if (!dirs(join(root, host)).length) await removeTree(join(root, host), 'deleting pull request checkouts');
    }
  }
  return { kept: kept.sort() };
}

// ---- storage ----------------------------------------------------------------------------------

export interface CheckoutUsage {
  bytes: number;
  /** "github.com/acme/ledger", one per clone. */
  repos: string[];
}

/** Disk use under root (symlinks not followed), and which repositories are there. */
export async function checkoutUsage(root: string): Promise<CheckoutUsage> {
  let bytes = 0;
  const walk = async (dir: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isDirectory()) await walk(p);
      else {
        try {
          bytes += (await lstat(p)).size;
        } catch {
          // vanished meanwhile
        }
      }
    }
  };
  await walk(root);
  const repos: string[] = [];
  const dirs = (p: string) => {
    try {
      return readdirSync(p, { withFileTypes: true }).filter((d) => d.isDirectory() && !d.name.startsWith('.')).map((d) => d.name);
    } catch {
      return [];
    }
  };
  for (const host of dirs(root)) for (const owner of dirs(join(root, host))) for (const repo of dirs(join(root, host, owner))) repos.push(`${host.replace('_', ':')}/${owner}/${repo}`);
  return { bytes, repos: repos.sort() };
}

/** "1.4 GB", "312 MB", "18 kB". */
export function formatBytes(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)} GB`;
  if (n >= 1e6) return `${Math.round(n / 1e6)} MB`;
  if (n >= 1e3) return `${Math.round(n / 1e3)} kB`;
  return `${n} bytes`;
}

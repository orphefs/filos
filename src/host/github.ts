// GitHub through the user's own `gh` CLI: find the pull request for the branch under review, and
// post a review to it. gh holds the login, so Filos never sees a token. Every call is an argument
// array (no shell), and every value that ends up in an API path is checked against a strict pattern
// first. No vscode import, so unit tests drive it with the fake gh in test/fixtures/fake-gh.

import { statSync } from 'node:fs';
import { offPathHint, runProcess, type RunResult } from '../agent/exec';
import { safeProgressText } from '../agent/progress';
import { buildGithubReview, type GithubReview, type GithubReviewComment } from '../review/github';
import type { DraftComment, PostTarget } from '../review/types';

export interface GhOptions {
  /** A name on PATH or an absolute path (the user-only setting filos.gh.path). */
  gh: string;
  /** The repository under review: gh finds its remote and the branch's pull request from here. */
  cwd: string;
  /** Defaults to process.env. */
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface PullRequest {
  /** github.com, or a GitHub Enterprise host. */
  host: string;
  owner: string;
  repo: string;
  number: number;
  url: string;
  /** The commit GitHub has as the PR's head; reviews are posted against it. */
  headRefOid: string;
  baseRefName: string;
  /** OPEN, CLOSED or MERGED. `gh pr view` also finds a branch's closed and merged PRs; only an open one is posted to. */
  state?: string;
  /** The PR's head branch on GitHub. */
  headRefName?: string;
}

export type PullRequestLookup = { ok: true; pr: PullRequest } | { ok: false; reason: string };

/** A failed gh call, with a message that is safe to show (no link syntax, bounded). */
export class GhError extends Error {
  /**
   * For a post: the request may still have reached GitHub (gh was killed, or the answer was a 5xx
   * or a broken connection), so the review may exist. Posting again could post it twice.
   */
  uncertain = false;

  constructor(
    message: string,
    readonly kind: 'notInstalled' | 'auth' | 'noPullRequest' | 'noRemote' | 'timeout' | 'cancelled' | 'api' | 'failed',
    /** Raw stderr/stdout tail, for the log only. */
    readonly detail?: string,
  ) {
    super(message);
    this.name = 'GhError';
  }
}

export const PR_VIEW_FIELDS = 'number,url,headRefOid,baseRefName,state,headRefName';
const VIEW_TIMEOUT_MS = 30_000;
/**
 * Long on purpose: a post killed half way may still land, and its outcome is then unknown. A big
 * review on a slow GitHub Enterprise link can take a while; a kill is the last resort.
 */
const POST_TIMEOUT_MS = 600_000;

/** What GitHub allows in an owner (user or organisation) name, a repository name and a host. */
export const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
export const REPO = /^[A-Za-z0-9._-]{1,100}$/;
export const HOST = /^[a-z0-9](?:[a-z0-9.-]{0,252})(?::\d{1,5})?$/;
export const OID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

/**
 * gh quietly: no prompts, no update checks, no colour; git under it never asks for a password.
 * `explicit`: the call names its host and repository itself (a URL, --hostname, host/owner/repo),
 * so a GH_HOST or GH_REPO the user's shell exports for another server (GitHub Enterprise users
 * often have one) can't send it elsewhere.
 */
export function ghEnv(env: NodeJS.ProcessEnv | undefined, opts: { explicit?: boolean } = {}): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...(env ?? process.env), GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1', GH_SPINNER_DISABLED: '1', NO_COLOR: '1', CLICOLOR: '0', GIT_TERMINAL_PROMPT: '0' };
  if (opts.explicit) {
    delete out.GH_HOST;
    delete out.GH_REPO;
  }
  return out;
}

async function gh(o: GhOptions, args: readonly string[], stdin?: string, timeoutMs = VIEW_TIMEOUT_MS, explicit = false): Promise<RunResult> {
  const r = await runProcess({
    command: o.gh,
    args,
    cwd: o.cwd,
    env: ghEnv(o.env, { explicit }),
    stdin,
    signal: o.signal,
    timeoutMs: o.timeoutMs ?? timeoutMs,
    collectStdout: true,
    maxCollectBytes: 1024 * 1024,
    maxStdoutBytes: 8 * 1024 * 1024,
  });
  // A missing cwd fails to spawn with ENOENT too, which would read as "can't find the GitHub CLI".
  if (r.spawnError?.code === 'ENOENT' && !isDirectory(o.cwd)) {
    r.spawnError = Object.assign(new Error(`the folder it runs in is gone (${o.cwd}). Review the pull request again`), { code: 'ENOTDIR' });
  }
  return r;
}

function isDirectory(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** Turns a failed run into a GhError. `what` names the step, e.g. "looking up the pull request". */
export function ghFailure(r: RunResult, what: string, ghPath: string, timeoutMs = VIEW_TIMEOUT_MS): GhError {
  const stderr = r.stderrTail.trim();
  const detail = [stderr, r.stdout.trim()].filter(Boolean).join('\n').slice(-4000);
  if (r.spawnError) {
    if (r.spawnError.code === 'ENOENT') return new GhError(`Filos can't find the GitHub CLI ("${safeProgressText(ghPath, 120)}"). Install gh and run "gh auth login", or set "filos.gh.path".${offPathHint(ghPath, 'filos.gh.path')}`, 'notInstalled');
    return new GhError(`Filos couldn't start the GitHub CLI: ${safeProgressText(r.spawnError.message, 160)}`, 'failed');
  }
  if (r.aborted) return new GhError(`Cancelled while ${what}.`, 'cancelled');
  if (r.timedOut) return new GhError(`The GitHub CLI didn't answer within ${Math.round(timeoutMs / 1000)} seconds while ${what}.`, 'timeout', detail);
  // Order matters: gh's "no GitHub remote" message also mentions `gh auth login`.
  if (/none of the git remotes|no git remotes|not a git repository/i.test(stderr)) {
    return new GhError("This repository has no GitHub remote, so there's no pull request to post to. Use Export instead.", 'noRemote', detail);
  }
  if (/no (?:open )?pull requests? found|could not find (?:any )?pull request/i.test(stderr)) {
    return new GhError("There's no pull request for this branch on GitHub. Push the branch and open one, then review again, or use Export.", 'noPullRequest', detail);
  }
  if (r.exitCode === 4 || /gh auth login|not logged in|authentication required|HTTP 401|bad credentials/i.test(stderr)) {
    return new GhError('The GitHub CLI is not logged in. Run "gh auth login" in a terminal, then try again.', 'auth', detail);
  }
  const http = /\(HTTP (\d{3})\)/.exec(stderr);
  if (http) return new GhError(`GitHub returned HTTP ${http[1]} while ${what}: ${apiMessage(r.stdout) ?? firstLine(stderr)}`, 'api', detail);
  return new GhError(`The GitHub CLI failed while ${what}: ${firstLine(stderr) || `exit code ${r.exitCode ?? r.signal ?? '?'}`}`, 'failed', detail);
}

const firstLine = (text: string) => safeProgressText(text.split('\n').find((l) => l.trim()) ?? '', 200);

/** GitHub's JSON error body: "message", plus "errors" (strings or objects with a message). */
function apiMessage(stdout: string): string | undefined {
  try {
    const j = JSON.parse(stdout) as { message?: unknown; errors?: unknown };
    const errs = Array.isArray(j.errors) ? j.errors.map((e) => (typeof e === 'string' ? e : typeof (e as { message?: unknown })?.message === 'string' ? (e as { message: string }).message : '')).filter(Boolean) : [];
    const text = [typeof j.message === 'string' ? j.message : '', ...errs].filter(Boolean).join(': ');
    return text ? safeProgressText(text, 240) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * owner/repo/number from a pull request URL (https://host/owner/repo/pull/n). Undefined for
 * anything else, including extra path parts, a query or a fragment.
 */
export function parsePullRequestUrl(url: string): { host: string; owner: string; repo: string; number: number } | undefined {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return undefined;
  }
  if (u.protocol !== 'https:' || u.username || u.password || u.search || u.hash) return undefined;
  const m = /^\/([^/]+)\/([^/]+)\/pull\/(\d{1,9})\/?$/.exec(u.pathname);
  if (!m || !OWNER.test(m[1]) || !REPO.test(m[2]) || m[2] === '.' || m[2] === '..') return undefined;
  const host = u.host.toLowerCase();
  if (!HOST.test(host)) return undefined;
  return { host, owner: m[1], repo: m[2], number: Number(m[3]) };
}

/** The `gh pr view --json` answer, checked; `repoFallback` is used when the URL can't be parsed. */
export function pullRequestFromView(raw: unknown, repoFallback?: { host: string; owner: string; repo: string }): PullRequest | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const v = raw as Record<string, unknown>;
  const number = v.number;
  if (typeof number !== 'number' || !Number.isInteger(number) || number < 1) return undefined;
  if (typeof v.headRefOid !== 'string' || !OID.test(v.headRefOid)) return undefined;
  if (typeof v.baseRefName !== 'string' || !v.baseRefName.trim()) return undefined;
  const url = typeof v.url === 'string' ? v.url : '';
  const parsed = parsePullRequestUrl(url);
  const fromUrl = parsed && parsed.number === number ? parsed : undefined;
  const where = fromUrl ?? repoFallback;
  if (!where) return undefined;
  const pr: PullRequest = { host: where.host, owner: where.owner, repo: where.repo, number, url: fromUrl ? url : `https://${where.host}/${where.owner}/${where.repo}/pull/${number}`, headRefOid: v.headRefOid, baseRefName: v.baseRefName };
  if (typeof v.state === 'string' && v.state.trim()) pr.state = v.state.trim().toUpperCase();
  if (typeof v.headRefName === 'string' && v.headRefName.trim()) pr.headRefName = v.headRefName;
  return pr;
}

/** Same repository and number: the same pull request. */
export function samePullRequest(a: Pick<PullRequest, 'host' | 'owner' | 'repo' | 'number'>, b: Pick<PullRequest, 'host' | 'owner' | 'repo' | 'number'>): boolean {
  return a.host === b.host && a.owner.toLowerCase() === b.owner.toLowerCase() && a.repo.toLowerCase() === b.repo.toLowerCase() && a.number === b.number;
}

/** `gh repo view --json nameWithOwner,url`, checked. */
export function repoFromView(raw: unknown): { host: string; owner: string; repo: string } | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const v = raw as Record<string, unknown>;
  const m = typeof v.nameWithOwner === 'string' ? /^([^/]+)\/([^/]+)$/.exec(v.nameWithOwner) : null;
  if (!m || !OWNER.test(m[1]) || !REPO.test(m[2]) || m[2] === '.' || m[2] === '..') return undefined;
  let host = 'github.com';
  if (typeof v.url === 'string') {
    try {
      const h = new URL(v.url).host.toLowerCase();
      if (HOST.test(h)) host = h;
    } catch {
      // keep github.com
    }
  }
  return { host, owner: m[1], repo: m[2] };
}

const parseJson = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};

/**
 * The pull request for the checked-out branch, or why there's none. With `known` (a PR found
 * before), that same PR again, by its URL, whatever is checked out now. Check `state` (postTargetOf
 * does): for a branch without an open PR, gh answers with its latest closed or merged one.
 */
export async function detectPullRequest(o: GhOptions, known?: Pick<PullRequest, 'host' | 'owner' | 'repo' | 'number'>): Promise<PullRequestLookup> {
  try {
    let selector: string[] = [];
    if (known) {
      const url = `https://${known.host}/${known.owner}/${known.repo}/pull/${known.number}`;
      const back = parsePullRequestUrl(url);
      if (!back || !samePullRequest(back, known)) return { ok: false, reason: 'The pull request details look wrong, so Filos stopped before posting.' };
      selector = [url];
    }
    // By URL, the host is in the call itself: GH_HOST/GH_REPO from the environment can't redirect it.
    const view = await gh(o, ['pr', 'view', ...selector, '--json', PR_VIEW_FIELDS], undefined, VIEW_TIMEOUT_MS, !!known);
    if (view.exitCode !== 0 || view.spawnError || view.aborted || view.timedOut) throw ghFailure(view, 'looking up the pull request', o.gh, o.timeoutMs);
    const raw = parseJson(view.stdout);
    let pr = pullRequestFromView(raw);
    if (!pr && raw) {
      // A URL we can't read (an odd Enterprise layout, say): ask gh which repo this is.
      const repoView = await gh(o, ['repo', 'view', '--json', 'nameWithOwner,url']);
      if (repoView.exitCode !== 0 || repoView.spawnError || repoView.aborted || repoView.timedOut) throw ghFailure(repoView, 'looking up the repository', o.gh, o.timeoutMs);
      pr = pullRequestFromView(raw, repoFromView(parseJson(repoView.stdout)));
    }
    if (!pr) return { ok: false, reason: "The GitHub CLI's answer about this branch's pull request couldn't be read, so Filos won't post to it. Use Export instead." };
    return { ok: true, pr };
  } catch (e) {
    return { ok: false, reason: e instanceof GhError ? e.message : `Looking up the pull request failed: ${safeProgressText(String(e), 200)}` };
  }
}

/** Where a post would go: an open pull request, or why there's none (a closed or merged one isn't posted to). */
export function postTargetOf(lookup: PullRequestLookup): PostTarget {
  if (!lookup.ok) return { kind: 'none', reason: lookup.reason };
  const pr = lookup.pr;
  if (pr.state !== 'OPEN') {
    const what = pr.state === 'MERGED' ? 'is merged' : pr.state === 'CLOSED' ? 'is closed' : "isn't known to be open";
    return { kind: 'none', reason: `The pull request (${pr.owner}/${pr.repo}#${pr.number}) ${what}, so Filos won't post to it. Use Export instead.` };
  }
  return { kind: 'github', repo: `${pr.owner}/${pr.repo}`, number: pr.number, url: pr.url };
}

// ---- posting --------------------------------------------------------------------------------

/** The body sent when every comment sits inline: GitHub's API asks for a body with event COMMENT. */
export const INLINE_ONLY_BODY = 'See the inline comments.';

export interface ReviewPayload {
  event: 'COMMENT';
  body: string;
  comments: GithubReviewComment[];
  commit_id: string;
}

export interface ReviewRequest {
  args: string[];
  payload: ReviewPayload;
}

/**
 * gh api arguments and the JSON for stdin. The path parts were checked when the PR was read. The
 * host is always named, github.com included: without --hostname, gh posts to GH_HOST when the
 * environment sets one, i.e. to another server than the one the confirmation names.
 */
export function reviewRequest(pr: PullRequest, review: GithubReview): ReviewRequest {
  if (!OWNER.test(pr.owner) || !REPO.test(pr.repo) || !Number.isInteger(pr.number) || pr.number < 1 || !OID.test(pr.headRefOid) || !HOST.test(pr.host)) {
    throw new GhError('The pull request details look wrong, so Filos stopped before posting.', 'failed');
  }
  const args = ['api', '--hostname', pr.host, '-X', 'POST', `repos/${pr.owner}/${pr.repo}/pulls/${pr.number}/reviews`, '--input', '-'];
  return { args, payload: { event: 'COMMENT', body: review.body.trim() ? review.body : INLINE_ONLY_BODY, comments: review.comments, commit_id: pr.headRefOid } };
}

/**
 * Whether the review matches what GitHub has: inline comments need the commit that was reviewed
 * (`headOid`, resolved when the diff was computed) to be the PR's head, and the same base branch.
 * Otherwise their lines may have moved, or not be lines of the PR's diff at all.
 */
export function inlineMismatch(pr: PullRequest, local: { headOid?: string; base: string }): string | undefined {
  if (!local.headOid || local.headOid !== pr.headRefOid) {
    const short = (s?: string) => (s ? s.slice(0, 7) : 'unknown');
    return `The commit you reviewed (${short(local.headOid)}) isn't the pull request's head (${short(pr.headRefOid)}): the pull request changed since, and lines may have moved.`;
  }
  const base = local.base.replace(/^refs\/(?:heads|remotes)\//, '');
  if (base !== pr.baseRefName && !base.endsWith(`/${pr.baseRefName}`)) {
    return `You reviewed against ${safeProgressText(local.base, 60)}, but the pull request targets ${safeProgressText(pr.baseRefName, 60)}.`;
  }
  return undefined;
}

export interface PostPlan {
  request: ReviewRequest;
  inline: number;
  general: number;
  /** Why everything goes in the body, if it does. */
  mismatch?: string;
  /** Comments on a line of an earlier commit than the one reviewed: they go in the body. */
  outdated: number;
}

/**
 * What a post would send: accepted comments inline when their head line is in the diff, the line is
 * one of the reviewed commit (`local.headOid`) and that commit is the PR's head; otherwise in the
 * review body with their file and line.
 */
export function planPost(pr: PullRequest, comments: readonly DraftComment[], headLines: ReadonlyMap<string, ReadonlySet<number>>, local: { headOid?: string; base: string }): PostPlan {
  const mismatch = inlineMismatch(pr, local);
  const anchored = (c: DraftComment) => c.commit === local.headOid;
  const review = buildGithubReview(comments, mismatch ? new Map() : headLines, anchored);
  const accepted = comments.filter((c) => c.status === 'accepted' && c.body.trim());
  const outdated = mismatch ? 0 : accepted.filter((c) => c.file && c.line && !anchored(c)).length;
  return { request: reviewRequest(pr, review), inline: review.comments.length, general: accepted.length - review.comments.length, ...(mismatch ? { mismatch } : {}), outdated };
}

/**
 * The modal's text: where it goes, how many comments, and that it is public. Plain text. Anything
 * the reviewer should weigh first (the PR changed since the review, an earlier post that may have
 * landed) leads the detail, and the question then says "anyway".
 */
export function confirmationText(pr: PullRequest, plan: PostPlan, extra: { maybePosted?: number } = {}): { message: string; detail: string } {
  const n = (k: number, one: string, many: string) => `${k} ${k === 1 ? one : many}`;
  const warnings: string[] = [];
  if (extra.maybePosted) {
    warnings.push(
      `An earlier attempt to post ${n(extra.maybePosted, 'of these comments', 'of these comments')} ended without a clear answer from GitHub, so ${extra.maybePosted === 1 ? 'it' : 'they'} may already be on the pull request. Check it first, or ${extra.maybePosted === 1 ? 'it' : 'they'} may be posted twice.`,
    );
  }
  if (plan.mismatch) warnings.push(`${plan.mismatch} Every comment goes in the review body, with its file and line.`);
  else if (plan.outdated) warnings.push(`${n(plan.outdated, 'comment was', 'comments were')} written on an earlier commit than the one you reviewed, so ${plan.outdated === 1 ? 'it goes' : 'they go'} in the review body, with ${plan.outdated === 1 ? 'its' : 'their'} file and line.`);
  const parts: string[] = [];
  if (plan.inline) parts.push(`${n(plan.inline, 'comment', 'comments')} inline on changed lines`);
  if (plan.general) parts.push(`${n(plan.general, 'comment', 'comments')} in the review body`);
  const lines = [...warnings, `${parts.join(' and ')}.`];
  lines.push('The review is public: anyone who can see the pull request can read it, and GitHub notifies its author. It is posted as you, through the GitHub CLI.');
  const where = `${pr.owner}/${pr.repo}#${pr.number}`;
  return { message: warnings.length ? `Post your review to ${where} anyway?` : `Post your review to ${where}?`, detail: lines.join('\n\n') };
}

export interface PostResult {
  /** The review's page on GitHub, when GitHub returned one on the PR's own host. */
  url?: string;
  id?: number;
}

/**
 * POSTs the review with `gh api`; the JSON goes on stdin, never into argv. Rejects with GhError,
 * `uncertain` unless gh never ran or GitHub plainly refused the request (a 4xx, a login problem).
 */
export async function postReview(pr: PullRequest, request: ReviewRequest, o: GhOptions): Promise<PostResult> {
  const r = await gh(o, request.args, JSON.stringify(request.payload), POST_TIMEOUT_MS, true);
  if (r.exitCode !== 0 || r.spawnError || r.aborted || r.timedOut) {
    const e = ghFailure(r, 'posting the review', o.gh, o.timeoutMs ?? POST_TIMEOUT_MS);
    const status = /\(HTTP (\d{3})\)/.exec(r.stderrTail)?.[1];
    const refused = !!r.spawnError || e.kind === 'notInstalled' || e.kind === 'auth' || (!!status && status.startsWith('4'));
    e.uncertain = !refused;
    throw e;
  }
  const j = parseJson(r.stdout) as { html_url?: unknown; id?: unknown } | undefined;
  const out: PostResult = {};
  if (typeof j?.id === 'number') out.id = j.id;
  if (typeof j?.html_url === 'string') {
    try {
      const u = new URL(j.html_url);
      if (u.protocol === 'https:' && u.host.toLowerCase() === pr.host) out.url = u.toString();
    } catch {
      // no link then
    }
  }
  return out;
}

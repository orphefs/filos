// The host side of one review's questionnaire, comments and didactic progress. It owns the
// ReviewModel (src/review/model.ts), stores it after every change, sends the webview a snapshot,
// and carries out what the model's methods ask for: agent calls (questions, grading, drafting,
// threads), posting to GitHub and Export. The controller makes one per loaded graph and disposes
// it with the session, which cancels any agent call still running (they cost money).

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as vscode from 'vscode';
import { ProviderError, type AgentProvider, type AskResult, type ProviderConfig, type ProviderErrorKind } from '../agent';
import { safeProgressText } from '../agent/progress';
import { repoReader } from '../agent/repoFiles';
import { draftComments, evaluateAnswer, generateQuestions, numberedExcerpt, threadReply } from '../agent/tasks';
import type { Anchor, GraphNode, ReviewGraph } from '../contract/graph';
import type { QuestionSet } from '../contract/questions';
import { validateQuestionSet } from '../contract/validateQuestions';
import type { GraphSource, ReviewAction } from '../protocol';
import { diffHeadLines } from '../review/github';
import { reviewToMarkdown } from '../review/markdown';
import { ReviewModel, type QuestionsStatus, type ReviewEffect } from '../review/model';
import type { DraftComment, PostTarget, ReviewSnapshot } from '../review/types';
import { globalConfidenceStore } from './confidenceStore';
import { confirmationText, detectPullRequest, GhError, planPost, postReview, postTargetOf, samePullRequest, type PullRequest, type PullRequestLookup, type ReviewPayload } from './github';
import type { ReviewSession } from './session';

export const MODE_STATE_KEY = 'filos.mode';
export const SAMPLE_POST_REASON = "The sample isn't a GitHub pull request. Use Export to copy the review as Markdown.";
const LOOKING_UP_REASON = "Looking for this branch's pull request on GitHub…";
/** Lines of code sent with a grading or thread request: enough to reason about, cheap to send. */
export const MAX_EXCERPT_LINES = 120;
/** Lines either side of a comment's line, for a thread about it. */
const THREAD_CONTEXT_LINES = 15;

export interface ReviewHost {
  log: vscode.LogOutputChannel;
  globalState: vscode.Memento;
  extensionPath: string;
  /** Sends a snapshot to the webview. */
  send(review: ReviewSnapshot): void;
  /** A provider with the user's settings. Throws when the settings are invalid. */
  provider(): { provider: AgentProvider; config: ProviderConfig };
  /** Opens the provider's own login in a terminal. */
  openLogin(): void;
  /** The gh executable (user-only setting). Throws when the setting is invalid. */
  ghPath(): string;
  /** A modal confirmation, true when the reviewer chose `action`. Tests answer it themselves. */
  confirm(message: string, detail: string, action: string): Promise<boolean>;
  /** The editor column beside the review panel, for Export's document. */
  besideColumn(): vscode.ViewColumn;
}

/** The last post attempt, for the test API and the log. */
export interface PostRecord {
  at: number;
  args: string[];
  payload: ReviewPayload;
  url?: string;
  error?: string;
}

type TaskOutcome<T> = { ok: true; value: T } | { ok: false; kind: ProviderErrorKind; message: string };

export class ReviewState implements vscode.Disposable {
  readonly model: ReviewModel;
  /** For tests: what the last post sent, the last modal's text and the last export. */
  lastPost?: PostRecord;
  lastConfirmation?: { message: string; detail: string };
  lastExport?: string;

  private readonly abort = new AbortController();
  private lastSent?: string;
  private lastSaved: string;
  private postInFlight = false;
  /** The open pull request the panel names as the post target (looked up when the review started). */
  private pr?: PullRequest;
  private loginNotice = false;
  private readonly running = new Set<Promise<unknown>>();
  private reader?: (path: string) => string | undefined;

  constructor(
    private readonly host: ReviewHost,
    readonly session: ReviewSession,
    graph: ReviewGraph,
    readonly source: GraphSource,
  ) {
    const { questions, status } = this.initialQuestions(graph);
    this.model = new ReviewModel({
      graph,
      questions,
      questionsStatus: status,
      mode: host.globalState.get(MODE_STATE_KEY) === 'didactic' ? 'didactic' : 'fast',
      persisted: session.loadReview(),
      confidence: globalConfidenceStore(host.globalState, session.repoKey, (e) => host.log.warn(`saving confidence failed: ${String(e)}`)),
      agentAvailable: source === 'agent',
      post: this.initialPostTarget(),
      headOid: session.headOid,
      now: () => new Date().toISOString(),
    });
    // Only real changes are written back: opening a review must not store anything by itself.
    this.lastSaved = JSON.stringify(this.model.persisted());
  }

  get alive(): boolean {
    return !this.abort.signal.aborted;
  }

  /** Sends the first snapshot and starts the background work: questions (agent graphs) and the PR lookup. */
  start(): void {
    this.changed(true);
    if (this.source === 'agent') void this.track(this.writeQuestions());
    if (this.session.pullRequest) void this.track(this.usePullRequest(this.session.pullRequest));
  }

  /** The webview (re)loaded: it needs the snapshot again even if nothing changed. */
  resend(): void {
    this.changed(true);
  }

  /** A webview action. Resolves once whatever it started (an agent call, a post) has finished. */
  async apply(action: ReviewAction): Promise<void> {
    const effect = this.model.apply(action);
    if (action.type === 'setMode') void this.host.globalState.update(MODE_STATE_KEY, this.model.mode);
    this.changed();
    await this.track(this.run(effect));
  }

  /** May code open for this node? False while it is in didactic fog. Selecting closes the gate. */
  select(nodeId: string): boolean {
    const ok = this.model.select(nodeId);
    this.changed();
    return ok;
  }

  /** Resolves when every agent call and post started so far has finished. */
  async idle(): Promise<void> {
    while (this.running.size) await Promise.allSettled([...this.running]);
  }

  dispose(): void {
    this.abort.abort();
  }

  // ---- setup ----------------------------------------------------------------------------------

  private initialQuestions(graph: ReviewGraph): { questions?: QuestionSet; status: QuestionsStatus } {
    if (this.source === 'agent') return { status: { state: 'loading', message: 'The agent is writing questions about this change…' } };
    if (this.session.target.kind !== 'sample') return { status: { state: 'none', message: 'There are no questions for this review.' } };
    const file = join(this.host.extensionPath, 'fixtures', 'sample-questions.json');
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(file, 'utf8'));
    } catch (e) {
      this.host.log.error(`sample questions: ${String(e)}`);
      return { status: { state: 'error', message: "The sample's questions could not be read." } };
    }
    const v = validateQuestionSet(raw, graph, { readFile: this.read() });
    for (const w of v.warnings) this.host.log.warn(`sample questions: ${w}`);
    if (!v.ok) {
      this.host.log.error(`sample questions don't match the question-set contract:\n${v.errors.join('\n')}`);
      return { status: { state: 'error', message: "The sample's questions don't match the question-set contract. The Filos log has the details." } };
    }
    return { questions: v.value, status: { state: 'ready' } };
  }

  private initialPostTarget(): PostTarget {
    if (this.session.target.kind === 'sample') return { kind: 'none', reason: SAMPLE_POST_REASON };
    const known = this.session.knownPullRequest;
    if (known) {
      // A pull request review: the PR was looked up to start it, so the target is known now.
      const target = postTargetOf(known);
      this.pr = known.ok && target.kind === 'github' ? known.pr : undefined;
      return target;
    }
    return { kind: 'none', reason: this.session.pullRequest ? LOOKING_UP_REASON : 'Filos has no pull request for this review. Use Export instead.' };
  }

  private async usePullRequest(lookup: Promise<PullRequestLookup>): Promise<void> {
    const result = await lookup;
    if (!this.alive || this.postInFlight) return;
    const target = postTargetOf(result);
    this.pr = result.ok && target.kind === 'github' ? result.pr : undefined;
    this.host.log.info(
      result.ok
        ? `pull request: ${result.pr.owner}/${result.pr.repo}#${result.pr.number} (${result.pr.state ?? 'state unknown'}, head ${result.pr.headRefOid.slice(0, 7)}${result.pr.headRefName ? ` on ${result.pr.headRefName}` : ''})`
        : `no pull request to post to: ${result.reason}`,
    );
    this.model.setPostState({ target, status: 'idle' });
    this.changed();
  }

  // ---- state out ------------------------------------------------------------------------------

  /** Stores the review if it changed, then sends the snapshot if it changed (or `force`). */
  private changed(force = false): void {
    const persisted = this.model.persisted();
    const saved = JSON.stringify(persisted);
    if (saved !== this.lastSaved) {
      this.lastSaved = saved;
      // After dispose a newer review of this PR may own the stored state: only what a post did (one
      // that lands after the panel closed must still be recorded) is merged into it.
      const write = this.alive ? this.session.saveReview(persisted) : this.session.savePostedMarks(persisted);
      write.then(undefined, (e: unknown) => this.host.log.warn(`saving the review failed: ${String(e)}`));
    }
    if (!this.alive) return;
    const snap = this.model.snapshot();
    const sent = JSON.stringify(snap);
    if (!force && sent === this.lastSent) return;
    this.lastSent = sent;
    this.host.send(snap);
  }

  private track<T>(p: Promise<T>): Promise<T> {
    this.running.add(p);
    const done = () => this.running.delete(p);
    p.then(done, done);
    return p;
  }

  private run(effect: ReviewEffect): Promise<void> {
    switch (effect.kind) {
      case 'none':
        return Promise.resolve();
      case 'evaluate':
        return this.evaluate(effect.questionId, effect.attempt, effect.text);
      case 'thread':
        return this.thread(effect.commentId);
      case 'draft':
        return this.draft();
      case 'post':
        return this.post(effect.comments);
      case 'export':
        return this.export();
    }
  }

  // ---- agent tasks ----------------------------------------------------------------------------

  /**
   * Runs one agent task with the user's settings and this review's cancellation. Failures come
   * back as plain, safe text; an expired login also offers "Log in again".
   */
  private async agentTask<T>(what: string, run: (p: AgentProvider, signal: AbortSignal) => Promise<AskResult<T>>): Promise<TaskOutcome<T>> {
    let provider: AgentProvider;
    let config: ProviderConfig;
    try {
      ({ provider, config } = this.host.provider());
    } catch (e) {
      const message = `Filos could not set up the agent for ${what}: ${safeProgressText(errorText(e), 200)}`;
      this.host.log.error(message);
      return { ok: false, kind: 'failed', message };
    }
    const started = Date.now();
    try {
      const res = await run(provider, this.abort.signal);
      const cost = res.costUsd !== undefined ? `, $${res.costUsd.toFixed(3)}` : '';
      this.host.log.info(`agent ${what}: done in ${Math.round((res.durationMs ?? Date.now() - started) / 100) / 10} s${cost}`);
      for (const w of res.warnings) this.host.log.warn(`agent ${what}: ${w}`);
      return { ok: true, value: res.value };
    } catch (e) {
      const kind: ProviderErrorKind = e instanceof ProviderError ? e.kind : 'failed';
      this.host.log.error(`agent ${what} (${kind}): ${errorText(e)}${e instanceof ProviderError && e.detail ? `\n${e.detail}` : ''}`);
      if (!this.alive) return { ok: false, kind: 'cancelled', message: `${capital(what)} was cancelled.` };
      const message = taskFailure(kind, what, provider.displayName, config, e);
      if (kind === 'authExpired') this.offerLogin(message);
      return { ok: false, kind, message };
    }
  }

  private offerLogin(message: string): void {
    if (this.loginNotice) return; // one at a time: several calls can fail on the same expired login
    this.loginNotice = true;
    void vscode.window.showErrorMessage(`Filos: ${message}`, 'Log in again').then((choice) => {
      this.loginNotice = false;
      if (choice) this.host.openLogin();
    });
  }

  private warn(outcome: { kind: ProviderErrorKind; message: string }, next = ''): void {
    // Cancelled: the reviewer moved on. Expired login: offerLogin already said it.
    if (outcome.kind === 'cancelled' || outcome.kind === 'authExpired' || !this.alive) return;
    void vscode.window.showWarningMessage(`Filos: ${outcome.message}${next ? ` ${next}` : ''}`);
  }

  private async writeQuestions(): Promise<void> {
    const s = this.session;
    const diff = s.diff;
    if (!diff) {
      this.model.setQuestions(undefined, { state: 'error', message: 'Filos has no diff for this review, so the agent wrote no questions.' });
      this.changed();
      return;
    }
    await vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: 'Filos' }, async (progress) => {
      progress.report({ message: 'writing questions…' });
      const r = await this.agentTask('writing questions', (p, signal) =>
        generateQuestions(p, {
          repoRoot: s.target.repoRoot,
          graph: this.model.graph,
          diff,
          dependencyIndex: s.dependencyIndex,
          signal,
          onProgress: (m) => {
            if (!this.alive) return;
            // Progress names files and tools the agent chose: no link syntax, bounded.
            const text = safeProgressText(m);
            progress.report({ message: text });
            this.model.setQuestions(undefined, { state: 'loading', message: text });
            this.changed();
          },
        }),
      );
      if (!this.alive) return;
      if (r.ok) this.model.setQuestions(r.value, { state: 'ready' });
      else this.model.setQuestions(undefined, { state: 'error', message: r.message });
      this.changed();
    });
  }

  private async evaluate(questionId: string, attempt: number, text: string): Promise<void> {
    const q = this.model.question(questionId);
    if (!q) {
      this.model.failEvaluation(questionId, 'The question is gone.');
      this.changed();
      return;
    }
    const node = this.session.node(q.nodeId);
    const r = await this.agentTask('grading your answer', (p, signal) =>
      evaluateAnswer(p, { repoRoot: this.session.target.repoRoot, question: q, nodeSummary: nodeSummary(node), codeExcerpt: this.excerptFor(node), answer: text, attempt, signal }),
    );
    if (r.ok) this.model.applyEvaluation(questionId, r.value);
    else if (r.kind === 'cancelled' || !this.alive) {
      // Closed or re-run while grading: the answer goes back to unanswered, to be graded another
      // time. A self-check here would show the reference before the reviewer was graded.
      this.model.dropEvaluation(questionId);
    } else {
      this.model.failEvaluation(questionId, r.message);
      this.warn(r, 'Your answer is kept: compare it with the reference instead.');
    }
    this.changed();
  }

  private async thread(commentId: string): Promise<void> {
    const c = this.model.comment(commentId);
    const last = c?.thread[c.thread.length - 1];
    if (!c || last?.role !== 'user') {
      if (c) this.model.failThread(commentId, 'Filos lost track of your message. Send it again.');
      this.changed();
      return;
    }
    const node = c.nodeId !== undefined ? this.session.node(c.nodeId) : undefined;
    const excerpt = (c.file && c.line ? this.lineExcerpt(c.file, c.line) : '') || this.excerptFor(node);
    const r = await this.agentTask('replying in the thread', (p, signal) =>
      threadReply(p, {
        repoRoot: this.session.target.repoRoot,
        comment: { file: c.file, line: c.line, body: c.body, severity: c.severity },
        nodeSummary: nodeSummary(node),
        codeExcerpt: excerpt,
        thread: c.thread.slice(0, -1).map((m) => ({ role: m.role, text: m.text })),
        message: last.text,
        signal,
      }),
    );
    if (r.ok) this.model.applyThreadReply(commentId, r.value);
    else this.model.failThread(commentId, threadFailure(r.kind));
    this.changed();
  }

  private async draft(): Promise<void> {
    const answered = this.model
      .answered()
      .map(({ question, answer }) => {
        const last = answer.attempts[answer.attempts.length - 1];
        const choice = last?.choiceId !== undefined ? question.choices?.find((ch) => ch.id === last.choiceId)?.text : undefined;
        return { question, answer: choice ?? last?.text ?? '', verdict: last?.verdict ?? 'noted' };
      })
      .filter((a) => a.answer);
    const comments = this.model.snapshot().comments;
    // Rejected drafts are sent too, so the agent doesn't propose them again.
    const existing = comments.map((c) => ({ file: c.file, line: c.line, body: c.body }));
    const notes = comments.filter((c) => c.origin.kind === 'note').map((c) => c.body);
    const r = await this.agentTask('drafting comments', (p, signal) =>
      draftComments(p, { repoRoot: this.session.target.repoRoot, graph: this.model.graph, answered, notes, existing, signal }),
    );
    if (r.ok) {
      this.model.applyAgentDrafts(r.value.comments);
      if (!r.value.comments.length && this.alive) void vscode.window.showInformationMessage('Filos: the agent found nothing new to comment on.');
    } else {
      this.model.failDrafting(r.message);
      this.warn(r);
    }
    this.changed();
  }

  // ---- posting and export ---------------------------------------------------------------------

  /**
   * Looks the PR the panel names up again (by its URL, whatever is checked out now: it may have
   * moved, or been merged), shows a modal naming the repo, the PR and the comment counts, with any
   * warning first, and only then runs `gh api`. Never with zero comments. What is sent is read from
   * the model when it is sent; the comments being posted can't change meanwhile.
   */
  private async post(_clicked: DraftComment[]): Promise<void> {
    if (this.postInFlight) return;
    const target = this.model.snapshot().post.target;
    const end = (t: PostTarget, status: 'idle' | 'error', error?: string, outcome: { sent?: string[]; uncertain?: boolean } = {}) => {
      if (t.kind !== 'github') this.pr = undefined;
      this.model.setPostState({ target: t, status, ...(error ? { error } : {}) }, outcome);
      this.changed();
      if (error) void vscode.window.showErrorMessage(`Filos: ${error}`);
    };
    const reviewed = this.pr;
    if (target.kind !== 'github' || !reviewed) return end(target, 'idle');
    // 'posting' from here, so the model refuses a second post and any change to these comments
    // meanwhile. The webview shows it while the modal is up; cancelling goes back to idle.
    this.postInFlight = true;
    this.model.setPostState({ target, status: 'posting' });
    // Another review of this PR (an earlier panel whose post finished late) may have posted some.
    this.model.adoptPostedMarks(this.session.loadReview());
    this.changed();
    try {
      let comments = this.model.postingComments();
      if (!comments.length) {
        end(target, 'idle');
        const allPosted = this.model.snapshot().comments.some((c) => c.status === 'accepted' && this.model.isPosted(c.id));
        void vscode.window.showInformationMessage(allPosted ? 'Filos: every accepted comment is already posted.' : 'Filos: there is nothing to post yet. Accept at least one comment first.');
        return;
      }
      const s = this.session;
      if (!s.diff) return end(target, 'error', 'Filos has no diff for this review, so it cannot place comments. Use Export instead.');
      let gh: string;
      try {
        gh = this.host.ghPath();
      } catch (e) {
        return end(target, 'error', safeProgressText(errorText(e), 240));
      }
      const lookup = await detectPullRequest({ gh, cwd: s.target.repoRoot }, reviewed);
      if (!lookup.ok) return end(target, 'error', lookup.reason);
      const pr = lookup.pr;
      if (!samePullRequest(pr, reviewed)) return end(target, 'error', `GitHub answered with ${pr.owner}/${pr.repo}#${pr.number}, not the pull request this review is for (#${reviewed.number}), so Filos didn't post.`);
      const fresh = postTargetOf(lookup);
      if (fresh.kind !== 'github') return end(fresh, 'error', fresh.reason);

      comments = this.model.postingComments();
      const plan = planPost(pr, comments, diffHeadLines(s.diff), { headOid: s.headOid, base: s.target.base });
      const text = confirmationText(pr, plan, { maybePosted: comments.filter((c) => this.model.mayBePosted(c.id)).length });
      this.lastConfirmation = text;
      if (!(await this.host.confirm(text.message, text.detail, 'Post review'))) return end(fresh, 'idle');
      if (JSON.stringify(this.model.postingComments()) !== JSON.stringify(comments)) {
        return end(fresh, 'error', 'The comments changed while the confirmation was open, so nothing was posted. Post again to send them as they are now.');
      }

      const record: PostRecord = { at: Date.now(), args: plan.request.args, payload: plan.request.payload };
      this.lastPost = record;
      try {
        // Not cancellable: a post killed half way may still land, and would then be posted twice.
        const res = await postReview(pr, plan.request, { gh, cwd: s.target.repoRoot });
        record.url = res.url;
        this.model.setPostState({ target: fresh, status: 'posted', ...(res.url ? { url: res.url } : {}) }, { sent: comments.map((c) => c.id) });
        this.changed();
        this.host.log.info(`posted a review to ${pr.owner}/${pr.repo}#${pr.number}: ${plan.inline} inline, ${plan.general} in the body${plan.mismatch ? ` (${plan.mismatch})` : ''}`);
        const open = 'Open on GitHub';
        void vscode.window.showInformationMessage(`Filos: review posted to ${pr.owner}/${pr.repo}#${pr.number}.`, ...(res.url ? [open] : [])).then((c) => {
          if (c === open && res.url) void vscode.env.openExternal(vscode.Uri.parse(res.url));
        });
      } catch (e) {
        const uncertain = !(e instanceof GhError) || e.uncertain;
        const base = e instanceof GhError ? e.message : `Posting failed: ${safeProgressText(errorText(e), 200)}`;
        const message = uncertain ? `${base} The review may still have reached GitHub: check the pull request before posting again.` : base;
        record.error = message;
        this.host.log.error(`posting the review failed${uncertain ? ' (outcome unknown)' : ''}: ${base}${e instanceof GhError && e.detail ? `\n${e.detail}` : ''}`);
        end(fresh, 'error', message, { sent: comments.map((c) => c.id), uncertain });
      }
    } catch (e) {
      // Anything unexpected (git, the modal): never leave the model stuck in 'posting'.
      end(target, 'error', `Posting failed: ${safeProgressText(errorText(e), 200)}`);
    } finally {
      this.postInFlight = false;
    }
  }

  /** Markdown of the review: on the clipboard, and open in an untitled editor beside the panel. */
  private async export(): Promise<void> {
    const md = reviewToMarkdown(this.model.snapshot(), this.model.graph, this.session.target.prTitle);
    this.lastExport = md;
    await vscode.env.clipboard.writeText(md);
    const doc = await vscode.workspace.openTextDocument({ language: 'markdown', content: md });
    await vscode.window.showTextDocument(doc, { viewColumn: this.host.besideColumn(), preview: false });
    void vscode.window.showInformationMessage('Filos: the review is on the clipboard as Markdown, and open in a new editor.');
  }

  // ---- code for the agent ---------------------------------------------------------------------

  private read(): ((path: string) => string | undefined) | undefined {
    if (this.reader) return this.reader;
    try {
      this.reader = repoReader(this.session.target.repoRoot);
    } catch (e) {
      this.host.log.warn(`cannot read ${this.session.target.repoRoot}: ${String(e)}`);
    }
    return this.reader;
  }

  /** The node's code; for an external (no code here), the code of what it is linked to. */
  private excerptFor(node: GraphNode | undefined): string {
    if (!node) return '';
    let anchors = this.session.anchorsFor(node);
    if (!anchors.length) {
      const linked = this.model.graph.edges.filter((e) => e.from === node.id || e.to === node.id).map((e) => (e.from === node.id ? e.to : e.from));
      anchors = linked.flatMap((id) => {
        const n = this.session.node(id);
        return n ? this.session.anchorsFor(n) : [];
      });
    }
    return codeExcerpt(anchors, this.read(), MAX_EXCERPT_LINES);
  }

  private lineExcerpt(file: string, line: number): string {
    return codeExcerpt([{ file, startLine: Math.max(1, line - THREAD_CONTEXT_LINES), endLine: line + THREAD_CONTEXT_LINES }], this.read(), MAX_EXCERPT_LINES);
  }
}

/**
 * Numbered head-revision code for the anchors, merged per file and capped at `maxLines` in all,
 * so the agent can cite lines. Files that can't be read are skipped.
 */
export function codeExcerpt(anchors: readonly Anchor[], read: ((path: string) => string | undefined) | undefined, maxLines: number): string {
  if (!read) return '';
  const byFile = new Map<string, { start: number; end: number }[]>();
  for (const a of anchors) {
    const list = byFile.get(a.file) ?? [];
    list.push({ start: a.startLine, end: a.endLine });
    byFile.set(a.file, list);
  }
  const parts: string[] = [];
  let budget = maxLines;
  let cut = false;
  for (const [file, ranges] of byFile) {
    const text = read(file);
    if (text === undefined) continue;
    const lines = text.replace(/\n$/, '').split('\n');
    ranges.sort((x, y) => x.start - y.start);
    const merged: { start: number; end: number }[] = [];
    for (const r of ranges) {
      const start = Math.max(1, r.start);
      const end = Math.min(lines.length, r.end);
      if (end < start) continue;
      const prev = merged[merged.length - 1];
      if (prev && start <= prev.end + 1) prev.end = Math.max(prev.end, end);
      else merged.push({ start, end });
    }
    for (const r of merged) {
      if (budget <= 0) {
        cut = true;
        break;
      }
      const end = Math.min(r.end, r.start + budget - 1);
      if (end < r.end) cut = true;
      parts.push(numberedExcerpt(file, lines.slice(r.start - 1, end).join('\n'), r.start));
      budget -= end - r.start + 1;
    }
  }
  if (cut) parts.push(`(cut at ${maxLines} lines)`);
  return parts.join('\n\n');
}

function nodeSummary(node: GraphNode | undefined): string {
  if (!node) return '';
  return [`${node.label} (${node.kind}, ${node.change})`, node.summary, node.risk?.why ? `Risk: ${node.risk.why}` : ''].filter(Boolean).join('\n');
}

const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** One plain sentence for a failed task. `what` reads after "while", e.g. "grading your answer". */
function taskFailure(kind: ProviderErrorKind, what: string, name: string, cfg: ProviderConfig, e: unknown): string {
  switch (kind) {
    case 'authExpired':
      return `Your ${name} login has expired, so ${what} didn't happen.`;
    case 'notInstalled':
      return `Filos can't find the ${name} CLI, so ${what} didn't happen.`;
    case 'timeout':
      return `${name} didn't finish ${what} within ${cfg.timeoutSeconds} seconds.`;
    case 'budget':
      return `${name} reached the spending cap ($${cfg.maxBudgetUsd}) while ${what}.`;
    case 'contract':
      return `${name}'s answer while ${what} didn't match what Filos expects. The Filos log has the details.`;
    case 'cancelled':
      return `${capital(what)} was cancelled.`;
    default:
      return `${capital(what)} failed: ${safeProgressText(errorText(e), 160)}`;
  }
}

/** The agent's turn in a thread when it couldn't reply: plain text, by kind only (never raw error text). */
function threadFailure(kind: ProviderErrorKind): string {
  switch (kind) {
    case 'authExpired':
      return "I couldn't reply: the agent's login has expired. Log in again, then send your message again.";
    case 'timeout':
      return "I couldn't reply in time. Send your message again to retry.";
    case 'budget':
      return "I couldn't reply: the spending cap was reached.";
    case 'cancelled':
      return 'The reply was cancelled.';
    default:
      return "I couldn't reply this time (the Filos log has the details). Send your message again to retry.";
  }
}

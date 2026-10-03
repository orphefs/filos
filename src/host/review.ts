// Orchestrates a review: picks the repo and range, gets a graph (bundled fixture or agent), keeps
// the session, and routes webview messages to the code pane. The only place that knows all parts.

import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve, sep } from 'node:path';
import * as vscode from 'vscode';
import { createProvider, ProviderError, type AgentProvider, type ProviderConfig } from '../agent';
import { resolveCommand } from '../agent/exec';
import { safeProgressText } from '../agent/progress';
import type { ReviewGraph } from '../contract/graph';
import { validateGraph } from '../contract/validate';
import type { ErrorAction, GraphSource, HostToWebview, LoadingStep, ReviewAction, WebviewToHost } from '../protocol';
import type { ReviewSnapshot } from '../review/types';
import type { Held } from './checkoutLocks';
import { CodePane } from './codePane';
import { readGhPath, readProviderConfig } from './config';
import { repoKeyFor } from './confidenceStore';
import { DEP_INDEX, diffTouchesIndex, readDependencyIndex } from './depIndex';
import { describeAgentError, type ErrorView } from './errors';
import { OutlineFoldingProvider } from './folding';
import * as git from './git';
import { detectPullRequest, HOST, type PullRequestLookup } from './github';
import { ReviewPanel } from './panel';
import {
  checkoutsIdle,
  checkoutUsage,
  deleteCheckouts,
  describeInput,
  ensureStorage,
  formatBytes,
  headLabel,
  parsePullRequestInput,
  prepareCheckout,
  PrError,
  prLabel,
  prSummary,
  pullRequestDiff,
  toPullRequest,
  viewPullRequest,
  type PullRequestInput,
} from './pr';
import { prCodeLocation } from './prFiles';
import { pickPullRequest } from './prPicker';
import { ReviewState } from './reviewState';
import { materialiseSample, type SampleRepo } from './sample';
import { migrateStored, ReviewSession, type RenderedInfo, type ReviewTarget } from './session';
import { LoadingSteps } from './steps';

interface AgentInput {
  diff: string;
  dependencyIndex?: string;
  /** Shown under every loading message, e.g. "Comparing feature-x with main". */
  note?: string;
  warnings: string[];
}

interface RenderWaiter {
  predicate: (r: RenderedInfo) => boolean;
  resolve: (r: RenderedInfo) => void;
}

/** Which login the error view's "Log in again" opens: the agent CLI's, or gh's (for a host). */
type LoginTarget = { kind: 'agent' } | { kind: 'gh'; host?: string };

/** The steps of a pull request review, in order. */
const PR_STEP = { find: 0, code: 1, read: 2, questions: 3 } as const;
const PR_STEP_WHAT = ['finding the pull request', 'getting its code', 'reading the change', 'writing questions'];

export interface BranchReviewOptions {
  /** Base ref to compare with; skips the default lookup (and the picker). */
  base?: string;
  /** Always ask for the base branch. */
  pickBase?: boolean;
}

export class ReviewController implements vscode.Disposable {
  readonly folding: OutlineFoldingProvider;
  readonly codePane: CodePane;
  private readonly panel: ReviewPanel;
  private session?: ReviewSession;
  /** Repeats whatever was last attempted, for the error view's "Retry". */
  private lastAttempt?: () => Promise<void>;
  private lastBranchOptions: BranchReviewOptions = {};
  /** The pull request last asked for (by URL once found), for Re-run. */
  private lastPullRequest?: { input: PullRequestInput; workspaceRoot?: string };
  private loginFor: LoginTarget = { kind: 'agent' };
  private agentRun?: AbortController;
  private lastProvider?: AgentProvider;
  private waiters: RenderWaiter[] = [];
  /** Questionnaire, comments and didactic state of the loaded graph. */
  private review?: ReviewState;
  /**
   * This window's lease on the pull request worktree the current session reviews: other windows
   * leave it alone until the session ends (checkoutLocks.ts).
   */
  private lease?: Held;
  /**
   * Tests answer the posting confirmation themselves (a modal would block the test run).
   * Undefined: the real modal.
   */
  confirmOverride?: (message: string, detail: string) => boolean;

  /** Where pull request clones and worktrees live (Filos's own storage, never the workspace). */
  get pullRequestStorage(): string {
    return join(this.context.globalStorageUri.fsPath, 'prs');
  }

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly log: vscode.LogOutputChannel,
  ) {
    this.folding = new OutlineFoldingProvider((uri) => this.session?.outlineFor(uri));
    this.panel = new ReviewPanel(context.extensionUri, { onMessage: (m) => this.onMessage(m), onDispose: () => this.onPanelClosed() }, log);
    this.codePane = new CodePane({ panel: () => this.panel.webviewPanel, log });
  }

  get currentSession(): ReviewSession | undefined {
    return this.session;
  }

  get webviewPanel(): vscode.WebviewPanel | undefined {
    return this.panel.webviewPanel;
  }

  get webviewReady(): boolean {
    return this.panel.isReady;
  }

  get currentReview(): ReviewState | undefined {
    return this.review;
  }

  // ---- commands -------------------------------------------------------------------------------

  /** The bundled sample with its hand-written graph: instant, no agent, no cost. */
  async reviewSample(): Promise<void> {
    this.lastAttempt = () => this.reviewSample();
    this.cancelAgent();
    const repo = await this.prepareSample();
    if (!repo) return;
    const session = this.startSession({ kind: 'sample', repoRoot: repo.repoRoot, base: repo.base, head: repo.head, prTitle: repo.prTitle });
    const file = join(this.context.extensionPath, 'fixtures', 'sample-graph.json');
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(file, 'utf8'));
    } catch (e) {
      this.fail(session, 'The bundled sample graph could not be read.', ['retry'], String(e));
      return;
    }
    const v = validateGraph(raw, { readFile: repoReader(repo.repoRoot) });
    if (!v.ok) {
      this.fail(session, "The bundled sample graph doesn't match the review-graph contract.", ['retry'], v.errors.join('\n'));
      return;
    }
    this.loadGraph(session, v.graph, 'fixture', v.warnings);
  }

  /** The bundled sample, read by the configured agent: the real pipeline on a known change. */
  async reviewSampleWithAgent(): Promise<void> {
    this.lastAttempt = () => this.reviewSampleWithAgent();
    this.cancelAgent();
    const repo = await this.prepareSample();
    if (!repo) return;
    const session = this.startSession({ kind: 'sample', repoRoot: repo.repoRoot, base: repo.base, head: repo.head, prTitle: repo.prTitle });
    this.setLoading(session, 'Collecting the diff…');
    let diff: string;
    try {
      diff = await git.diff(repo.repoRoot, repo.base, repo.head, { env: repo.gitEnv });
    } catch (e) {
      this.fail(session, 'Could not compute the sample diff.', ['retry', 'useFixture'], String(e));
      return;
    }
    if (this.session !== session) return; // superseded while git ran
    const index = readDependencyIndex(repo.repoRoot);
    const warnings = [...git.diffWarnings(diff), ...(index.warning ? [index.warning] : [])];
    session.diff = diff;
    session.dependencyIndex = index.text;
    await this.runAgent(session, { diff, dependencyIndex: index.text, note: `Comparing ${repo.head} with ${repo.base}`, warnings });
  }

  /** Committed changes on the current branch of the first git workspace folder, read by the agent. */
  async reviewCurrentBranch(options: BranchReviewOptions = {}): Promise<void> {
    this.lastAttempt = () => this.reviewCurrentBranch(options);
    this.lastBranchOptions = options;
    if (!vscode.workspace.isTrusted) {
      const manage = 'Manage Workspace Trust';
      const choice = await vscode.window.showErrorMessage('Filos: reviewing the current branch runs git and the agent CLI in this folder, so the workspace must be trusted.', manage);
      if (choice === manage) await vscode.commands.executeCommand('workbench.trust.manage');
      return;
    }
    const folders = (vscode.workspace.workspaceFolders ?? []).filter((f) => f.uri.scheme === 'file');
    if (!folders.length) {
      void vscode.window.showErrorMessage('Filos: open a folder that is a git repository to review its current branch.');
      return;
    }
    let root: string | undefined;
    try {
      for (const f of folders) {
        root = await git.repoRoot(f.uri.fsPath);
        if (root) break;
      }
    } catch (e) {
      void vscode.window.showErrorMessage(`Filos: ${e instanceof Error ? e.message : String(e)}`);
      return;
    }
    if (!root) {
      void vscode.window.showErrorMessage(`Filos: ${folders.length === 1 ? `"${folders[0].name}" is not` : 'none of the workspace folders is'} in a git repository.`);
      return;
    }

    const head = await git.currentBranch(root);
    // The commit under review, resolved once: the diff, the graph and every comment's line refer to
    // it, so a later pull or checkout can't move the lines a comment is posted on.
    const headOid = await git.headCommit(root);
    if (!headOid) {
      void vscode.window.showErrorMessage(`Filos: ${head} has no commits to review.`);
      return;
    }
    let base = options.base ?? (options.pickBase ? undefined : await git.defaultBaseRef(root));
    if (!base) {
      base = await pickBase(root, head);
      if (!base) return;
      // Re-run and Retry keep the chosen base rather than asking again.
      const chosen = { base };
      this.lastBranchOptions = chosen;
      this.lastAttempt = () => this.reviewCurrentBranch(chosen);
    }
    if (!(await git.mergeBase(root, base, headOid))) {
      void vscode.window.showErrorMessage(`Filos: ${head} and ${base} have no common history to compare.`);
      return;
    }
    const diff = await git.diff(root, base, headOid);
    if (!diff.trim()) {
      const choice = await vscode.window.showErrorMessage(`Filos: no committed changes on ${head} since it branched from ${base}. Uncommitted changes are not reviewed.`, 'Choose Base Branch…');
      if (choice) await this.reviewCurrentBranch({ pickBase: true });
      return;
    }

    const warnings: string[] = git.diffWarnings(diff);
    let note = `Comparing ${head} with ${base}`;
    if (await git.hasUncommittedChanges(root)) {
      note += ' · uncommitted changes are ignored';
      warnings.push(`Only committed changes are reviewed: ${head} has uncommitted changes that are not in this graph.`);
    }
    const index = readDependencyIndex(root);
    if (index.warning) warnings.push(index.warning);
    const subjects = await git.commitSubjects(root, base, headOid);
    const prTitle = subjects.length === 1 ? subjects[0] : head;
    const repoRoot = realpathSync(root);
    const repoKey = repoKeyFor('branch', repoRoot, await git.originUrl(root));

    this.cancelAgent();
    const session = this.startSession({ kind: 'branch', repoRoot, base, head, prTitle }, repoKey);
    session.diff = diff;
    session.headOid = headOid;
    session.dependencyIndex = index.text;
    // gh takes a second or two; the agent takes minutes. Look the PR up while it works.
    session.pullRequest = this.lookUpPullRequest(repoRoot);
    await this.runAgent(session, { diff, dependencyIndex: index.text, note, warnings });
  }

  /**
   * "Review Pull Request…": a GitHub pull request by URL, owner/repo#n or number (the argument, for
   * tests and menus), or picked from the workspace repository's open pull requests. Its code goes
   * into Filos's own storage: the workspace is never checked out, fetched into or changed.
   */
  async reviewPullRequest(arg?: unknown): Promise<void> {
    try {
      readGhPath();
    } catch (e) {
      void vscode.window.showErrorMessage(`Filos: ${safeProgressText(errorText(e), 240)}`);
      return;
    }
    const workspaceRoot = await this.workspaceRepo();
    let input: PullRequestInput | undefined;
    const text = typeof arg === 'string' ? arg : typeof arg === 'number' ? String(arg) : undefined;
    if (text !== undefined) {
      input = parsePullRequestInput(text);
      if (!input) {
        void vscode.window.showErrorMessage(`Filos: "${safeProgressText(text, 80)}" isn't a pull request. Use its URL, owner/repo#number, or a number in the workspace's repository.`);
        return;
      }
    } else {
      input = await pickPullRequest({ gh: readGhPath(), repoRoot: workspaceRoot, log: this.log });
      if (!input) return;
    }
    if (input.kind === 'number' && !workspaceRoot) {
      void vscode.window.showErrorMessage(
        `Filos: #${input.number} needs a workspace folder whose repository is on GitHub${vscode.workspace.isTrusted ? '' : ' (in a trusted workspace)'}. Use the pull request's URL or owner/repo#number instead.`,
      );
      return;
    }
    await this.startPullRequest(input, workspaceRoot);
  }

  /** "Delete Pull Request Checkouts": removes every clone and worktree under Filos's storage, after a modal. */
  async cleanPullRequestCheckouts(): Promise<void> {
    const root = this.pullRequestStorage;
    const usage = existsSync(root) ? await checkoutUsage(root) : { bytes: 0, repos: [] };
    if (!usage.bytes && !usage.repos.length) {
      void vscode.window.showInformationMessage('Filos: there are no pull request checkouts to delete.');
      return;
    }
    const open = this.session?.target.kind === 'pr' ? this.session : undefined;
    const shown = usage.repos.slice(0, 8).join(', ') + (usage.repos.length > 8 ? ` and ${usage.repos.length - 8} more` : '');
    const message = `Delete ${formatBytes(usage.bytes)} of pull request checkouts?`;
    const detail = [
      'Filos keeps one clone per repository you reviewed a pull request from, so the next review of it only fetches what changed. Deleting them frees the space; the next review clones again. Your answers and comments are kept.',
      usage.repos.length ? `Repositories: ${shown}.` : '',
      open ? `The open review${open.target.pr ? ` of ${prLabel(open.target.pr)}` : ''} closes.` : '',
      'Repositories that another VS Code window is reviewing right now are kept.',
    ]
      .filter(Boolean)
      .join('\n\n');
    const ok = this.confirmOverride ? this.confirmOverride(message, detail) : (await vscode.window.showWarningMessage(message, { modal: true, detail }, 'Delete')) === 'Delete';
    if (!ok) return;
    // Closing the panel ends that review (and its lease) and stops whatever it was fetching or running.
    if (open && this.session === open) this.panel.dispose();
    await checkoutsIdle(root);
    let kept: string[];
    try {
      ({ kept } = await deleteCheckouts(root));
    } catch (e) {
      this.log.error(`deleting pull request checkouts: ${e instanceof PrError && e.detail ? e.detail : errorText(e)}`);
      void vscode.window.showErrorMessage(`Filos: ${safeProgressText(errorText(e), 300)}`);
      return;
    }
    const left = kept.length && existsSync(root) ? (await checkoutUsage(root)).bytes : 0;
    const freed = formatBytes(Math.max(0, usage.bytes - left));
    this.log.info(`deleted pull request checkouts: ${freed} in ${root}${kept.length ? `; kept ${kept.join(', ')} (in use in another window)` : ''}`);
    void vscode.window.showInformationMessage(
      kept.length
        ? `Filos: deleted ${freed} of pull request checkouts. Kept ${kept.join(', ')}: another VS Code window is reviewing ${kept.length === 1 ? 'it' : 'them'}.`
        : `Filos: deleted ${freed} of pull request checkouts.`,
    );
  }

  // ---- selection ------------------------------------------------------------------------------

  /** Same path as a click in the graph. In didactic mode, a node still in fog opens no code. */
  select(id: string, anchorIndex?: number): Promise<void> {
    const s = this.session;
    if (!s?.graph || !this.mayOpen(id)) return Promise.resolve();
    return this.codePane.show(id, anchorIndex);
  }

  /** Host-driven selection (tests, commands): move the graph's selection too. */
  selectFromHost(id: string): Promise<void> {
    const s = this.session;
    if (!s?.graph || !this.mayOpen(id)) return Promise.resolve();
    this.post({ type: 'select', id });
    return this.codePane.show(id);
  }

  /** Asks the review model (which also closes an open gate); true when there's no review yet. */
  private mayOpen(id: string): boolean {
    const r = this.review;
    if (!r || r.session !== this.session) return true;
    if (r.select(id)) return true;
    this.log.debug(`select ${id}: in fog (didactic mode), no code opened`);
    return false;
  }

  /**
   * A questionnaire, comment or didactic action, from the webview or a test. Resolves once any agent
   * call or post it started has finished; failures are shown, never thrown.
   */
  async applyReviewAction(action: ReviewAction): Promise<void> {
    const r = this.review;
    if (!r || r.session !== this.session) {
      this.log.debug(`review action ${action.type} with no review loaded`);
      return;
    }
    try {
      await r.apply(action);
    } catch (e) {
      this.log.error(`review action ${action.type}: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`);
      void vscode.window.showErrorMessage(`Filos: ${safeProgressText(e instanceof Error ? e.message : String(e), 200)}`, 'Show Log').then((c) => c && this.log.show());
    }
  }

  /** Resolves with the first rendered report (already received or upcoming) that matches. */
  waitForRendered(predicate: (r: RenderedInfo) => boolean = () => true, timeoutMs = 10_000): Promise<RenderedInfo> {
    const last = this.session?.lastRendered;
    if (last && predicate(last)) return Promise.resolve(last);
    return new Promise((resolvePromise, reject) => {
      const waiter: RenderWaiter = {
        predicate,
        resolve: (r) => {
          clearTimeout(timer);
          resolvePromise(r);
        },
      };
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((w) => w !== waiter);
        reject(new Error(`no matching "rendered" message from the webview within ${timeoutMs} ms`));
      }, timeoutMs);
      this.waiters.push(waiter);
    });
  }

  async handleAction(action: ErrorAction | 'rerun'): Promise<void> {
    switch (action) {
      case 'login':
        this.openLoginTerminal(this.loginFor);
        return;
      case 'retry':
        await (this.lastAttempt ?? (() => this.reviewSample()))();
        return;
      case 'useFixture':
        await this.reviewSample();
        return;
      case 'rerun': {
        const t = this.session?.target;
        if (t?.kind === 'branch') await this.reviewCurrentBranch(this.lastBranchOptions);
        else if (t?.kind === 'pr' && t.pr) await this.startPullRequest({ kind: 'url', ...t.pr }, this.lastPullRequest?.workspaceRoot);
        else if (t?.kind === 'pr' && this.lastPullRequest) await this.startPullRequest(this.lastPullRequest.input, this.lastPullRequest.workspaceRoot);
        else await this.reviewSampleWithAgent();
        return;
      }
    }
  }

  // ---- internals ------------------------------------------------------------------------------

  private onMessage(msg: WebviewToHost): void {
    const s = this.session;
    switch (msg.type) {
      case 'ready':
        if (s) this.panel.post(s.snapshot());
        if (s && this.review?.session === s) this.review.resend();
        return;
      case 'select':
        void this.select(msg.id);
        return;
      case 'openAnchor':
        void this.select(msg.id, msg.anchorIndex);
        return;
      case 'stateChanged':
        if (s) void s.saveState(msg.state);
        return;
      case 'action':
        // The webview has no spinner of its own for these: a failure must be shown, not only logged.
        void this.handleAction(msg.action).catch((e: unknown) => {
          this.log.error(`action ${msg.action}: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`);
          void vscode.window.showErrorMessage(`Filos: ${e instanceof Error ? e.message : String(e)}`, 'Show Log').then((c) => c && this.log.show());
        });
        return;
      case 'rendered': {
        if (!s) return;
        const info: RenderedInfo = { visibleNodes: msg.visibleNodes, expanded: msg.expanded, selected: msg.selected, at: Date.now() };
        s.lastRendered = info;
        const ready = this.waiters.filter((w) => w.predicate(info));
        this.waiters = this.waiters.filter((w) => !ready.includes(w));
        for (const w of ready) w.resolve(info);
        return;
      }
      default:
        void this.applyReviewAction(msg);
        return;
    }
  }

  /**
   * `reveal: false` keeps focus where it is, and `loading` is the status shown from the start: for a
   * session that continues one the user already sees (a pull request's steps).
   */
  private startSession(target: ReviewTarget, repoKey?: string, opts: { reveal?: boolean; loading?: { message: string; detail?: string; steps?: LoadingStep[] } } = {}): ReviewSession {
    this.endReview();
    // The previous session's worktree is no longer shown; a pull request session takes a lease of its own.
    this.releaseLease();
    // A pull request's review is the same from any window (or none): keyed by its URL in globalState.
    // A branch review belongs to its workspace.
    let store = this.context.workspaceState;
    if (target.kind === 'pr') {
      store = this.context.globalState;
      migrateStored(ReviewSession.keyFor(target), this.context.workspaceState, store);
    }
    const code = target.kind === 'pr' ? prCodeLocation(this.pullRequestStorage) : undefined;
    const session = new ReviewSession(target, store, repoKey ?? (target.kind === 'sample' ? repoKeyFor('sample', target.repoRoot) : target.repoRoot), code);
    if (opts.loading) session.setLoading(opts.loading.message, opts.loading.detail, opts.loading.steps);
    if (this.session) session.inheritOutlines(this.session);
    this.session = session;
    this.codePane.setSession(session);
    this.folding.refresh();
    if (opts.reveal === false && this.panel.webviewPanel) this.panel.webviewPanel.title = `Filos: ${target.prTitle}`;
    else this.panel.open(target.prTitle);
    this.post(session.snapshot());
    this.log.info(`review: ${target.kind} ${target.base}...${target.head} in ${target.repoRoot}`);
    return session;
  }

  private loadGraph(session: ReviewSession, graph: ReviewGraph, source: GraphSource, warnings: string[]): void {
    if (this.session !== session) return;
    session.load(graph, source, warnings);
    this.folding.refresh();
    this.codePane.refresh();
    if (this.panel.webviewPanel) this.panel.webviewPanel.title = `Filos: ${graph.pr.title}`;
    for (const w of warnings) this.log.warn(`graph: ${w}`);
    this.log.info(`loaded ${source} graph: ${graph.nodes.length} nodes, ${graph.edges.length} edges, ${graph.files.length} file outlines`);
    this.post(session.snapshot());
    this.startReview(session, graph, source);
    this.warmUp(session, graph);
  }

  /** The questionnaire for a freshly loaded graph; its first snapshot follows the 'load' message. */
  private startReview(session: ReviewSession, graph: ReviewGraph, source: GraphSource): void {
    this.endReview();
    const review: ReviewState = new ReviewState(
      {
        log: this.log,
        globalState: this.context.globalState,
        extensionPath: this.context.extensionPath,
        send: (snapshot: ReviewSnapshot) => {
          if (this.review === review) this.post({ type: 'review', review: snapshot });
        },
        provider: () => {
          const config = readProviderConfig();
          const provider = createProvider({ ...config, onRawLine: (line) => this.log.trace(`[cli] ${line.length > 2000 ? line.slice(0, 2000) + '…' : line}`) });
          this.lastProvider = provider;
          return { provider, config };
        },
        openLogin: () => this.openLoginTerminal({ kind: 'agent' }),
        ghPath: () => readGhPath(),
        confirm: async (message, detail, action) => {
          if (this.confirmOverride) return this.confirmOverride(message, detail);
          return (await vscode.window.showWarningMessage(message, { modal: true, detail }, action)) === action;
        },
        besideColumn: () => Math.min((this.panel.webviewPanel?.viewColumn ?? vscode.ViewColumn.One) + 1, vscode.ViewColumn.Nine) as vscode.ViewColumn,
      },
      session,
      graph,
      source,
    );
    this.review = review;
    review.start();
  }

  /** Drops the current review: its agent calls are cancelled (a post already confirmed still finishes). */
  private endReview(): void {
    this.review?.dispose();
    this.review = undefined;
  }

  /** Never rejects: any failure is a reason there's nothing to post to. */
  private lookUpPullRequest(repoRoot: string): Promise<PullRequestLookup> {
    let gh: string;
    try {
      gh = readGhPath();
    } catch (e) {
      return Promise.resolve({ ok: false, reason: safeProgressText(e instanceof Error ? e.message : String(e), 240) });
    }
    return detectPullRequest({ gh, cwd: repoRoot });
  }

  /**
   * Folding waits for every folding provider, including the language server's, which can take
   * seconds to start. Loading one changed file in the background (not shown) starts it while
   * the user is still reading the graph, so the first click is not the slow one.
   */
  private warmUp(session: ReviewSession, graph: ReviewGraph): void {
    const first = graph.nodes.find((n) => n.kind !== 'external' && n.anchors.length)?.anchors[0];
    if (!first) return;
    const uri = session.uriFor(first.file);
    if (!uri || !existsSync(session.absPath(first.file))) return;
    vscode.workspace.openTextDocument(uri).then(
      () => this.log.debug(`warmed up ${first.file}`),
      (e: unknown) => this.log.debug(`warm-up skipped: ${String(e)}`),
    );
  }

  private setLoading(session: ReviewSession, message: string, detail?: string, steps?: LoadingStep[]): void {
    if (this.session !== session) return;
    session.setLoading(message, detail, steps);
    this.post(session.snapshot());
  }

  private fail(session: ReviewSession, message: string, actions: ErrorAction[], detail?: string, steps?: LoadingStep[]): void {
    this.log.error(`${message}${detail ? `\n${detail}` : ''}`);
    if (this.session !== session) return;
    session.setError(message, actions, detail, steps);
    this.post(session.snapshot());
  }

  private post(msg: HostToWebview): void {
    this.panel.post(msg);
  }

  private async prepareSample(): Promise<SampleRepo | undefined> {
    try {
      const repo = await materialiseSample(join(this.context.extensionPath, 'fixtures'), this.context.globalStorageUri.fsPath, String(this.context.extension.packageJSON.version ?? '0'));
      this.log.info(`sample repo ${repo.created ? 'created' : 'reused'} at ${repo.repoRoot}`);
      return repo;
    } catch (e) {
      const text = e instanceof Error ? e.message : String(e);
      this.log.error(`sample repo: ${e instanceof Error ? (e.stack ?? text) : text}`);
      void vscode.window.showErrorMessage(`Filos: could not prepare the sample repository. ${text}`);
      return undefined;
    }
  }

  private async runAgent(session: ReviewSession, input: AgentInput): Promise<void> {
    // A newer review (or a closed panel) owns the view now: don't cancel its run or start a hidden one.
    if (this.session !== session) return;
    this.cancelAgent();
    let cfg: ProviderConfig;
    let provider: AgentProvider;
    try {
      cfg = readProviderConfig();
      provider = createProvider({ ...cfg, onRawLine: (line) => this.log.trace(`[cli] ${line.length > 2000 ? line.slice(0, 2000) + '…' : line}`) });
    } catch (e) {
      this.fail(session, 'Filos could not set up the agent.', ['useFixture'], e instanceof Error ? e.message : String(e));
      return;
    }
    this.lastProvider = provider;
    const abort = new AbortController();
    this.agentRun = abort;
    const isCurrent = () => this.agentRun === abort && this.session === session;
    const progressTo = (report: (m: string) => void) => (text: string) => {
      if (!isCurrent()) return;
      // Progress can carry agent-chosen text, and notifications render [x](command:...) as links.
      const message = safeProgressText(text);
      this.log.info(`agent: ${message}`);
      report(message);
      this.setLoading(session, message, input.note);
    };
    const started = Date.now();

    try {
      const result = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'Filos', cancellable: true },
        async (progress, token) => {
          token.onCancellationRequested(() => abort.abort());
          const report = progressTo((message) => progress.report({ message }));
          report(`Checking that ${provider.displayName} is ready…`);
          try {
            await provider.checkReady(abort.signal);
          } catch (e) {
            // Only answers that settle the matter stop us; anything else (an older CLI without
            // `auth status`, say) is left for the real run to classify.
            if (!(e instanceof ProviderError) || !['notInstalled', 'authExpired', 'cancelled'].includes(e.kind)) {
              this.log.warn(`readiness check inconclusive: ${e instanceof Error ? e.message : String(e)}`);
            } else throw e;
          }
          return provider.comprehend({
            repoRoot: session.target.repoRoot,
            diff: input.diff,
            base: session.target.base,
            head: session.target.head,
            prTitle: session.target.prTitle,
            dependencyIndex: input.dependencyIndex,
            signal: abort.signal,
            onProgress: report,
          });
        },
      );
      if (!isCurrent()) return;
      const cost = result.costUsd !== undefined ? `, $${result.costUsd.toFixed(3)}` : '';
      this.log.info(`agent finished in ${Math.round((result.durationMs ?? Date.now() - started) / 1000)} s${cost}`);
      this.loadGraph(session, result.graph, 'agent', [...input.warnings, ...result.warnings]);
    } catch (e) {
      if (!isCurrent()) return; // superseded by a newer review: that one owns the view now
      this.loginFor = { kind: 'agent' };
      const view = describeAgentError(e, {
        providerName: provider.displayName,
        loginCommand: provider.loginCommand,
        claudePath: cfg.claudePath,
        timeoutSeconds: cfg.timeoutSeconds,
        maxBudgetUsd: cfg.maxBudgetUsd,
      });
      const kind = e instanceof ProviderError ? e.kind : 'unexpected';
      this.log.error(`agent ${kind}: ${e instanceof Error ? e.message : String(e)}${e instanceof ProviderError && e.detail ? `\n${e.detail}` : ''}`);
      this.fail(session, view.message, view.actions, view.detail);
    } finally {
      if (this.agentRun === abort) this.agentRun = undefined;
    }
  }

  private cancelAgent(): void {
    this.agentRun?.abort();
    this.agentRun = undefined;
  }

  // ---- pull requests --------------------------------------------------------------------------

  /** The first trusted workspace folder in a git repository with a remote (gh reads its config), if any. */
  private async workspaceRepo(): Promise<string | undefined> {
    if (!vscode.workspace.isTrusted) return undefined;
    for (const f of (vscode.workspace.workspaceFolders ?? []).filter((x) => x.uri.scheme === 'file')) {
      try {
        const root = await git.repoRoot(f.uri.fsPath);
        if (root && (await git.git(root, ['remote'])).trim()) return root;
      } catch {
        // git missing, or not a repo: no workspace repository then
      }
    }
    return undefined;
  }

  /**
   * The whole flow for one pull request, as steps the loading view shows: find it (gh), get its code
   * (Filos's own clone and worktree), the comprehension pass (the agent CLI), then questions (the
   * review pane takes over once the graph is up). One cancellable notification covers it all.
   */
  private async startPullRequest(input: PullRequestInput, workspaceRoot: string | undefined): Promise<void> {
    this.lastPullRequest = { input, workspaceRoot };
    this.lastAttempt = () => this.startPullRequest(input, workspaceRoot);
    this.cancelAgent();
    let gh: string;
    let cfg: ProviderConfig;
    let provider: AgentProvider;
    try {
      gh = readGhPath();
      cfg = readProviderConfig();
      provider = createProvider({ ...cfg, onRawLine: (line) => this.log.trace(`[cli] ${line.length > 2000 ? line.slice(0, 2000) + '…' : line}`) });
    } catch (e) {
      void vscode.window.showErrorMessage(`Filos: ${safeProgressText(errorText(e), 240)}`);
      return;
    }
    this.lastProvider = provider;
    const root = this.pullRequestStorage;
    const label = describeInput(input);
    const steps = new LoadingSteps(['Find the pull request', 'Get the code', `${provider.displayName} reads the change`, `${provider.displayName} writes questions`]);

    // Until the code is here there's no repository to review: this session only carries the steps
    // (and, given a URL, the pull request: a re-run then keeps the folds of files already open).
    let message = `Reviewing ${label}`;
    let detail: string | undefined;
    steps.start(PR_STEP.find, label);
    const known = input.kind === 'url' ? { url: input.url, host: input.host, owner: input.owner, repo: input.repo, number: input.number } : undefined;
    let session = this.startSession({ kind: 'pr', repoRoot: root, base: '', head: '', prTitle: `Pull request ${label}`, ...(known ? { pr: known } : {}) }, undefined, { loading: { message, steps: steps.snapshot() } });
    const abort = new AbortController();
    this.agentRun = abort;
    const isCurrent = () => this.agentRun === abort && this.session === session;
    const show = () => {
      if (isCurrent()) this.setLoading(session, message, detail, steps.snapshot());
    };
    const started = Date.now();
    let unadopted: Held | undefined;

    try {
      await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Filos', cancellable: true }, async (progress, token) => {
        token.onCancellationRequested(() => abort.abort());
        // Everything shown here can carry GitHub's or the agent's text: no link syntax, bounded.
        const report = (text: string) => {
          if (isCurrent()) progress.report({ message: safeProgressText(text) });
        };

        // 1. Find the pull request. Meanwhile, check that the agent can run at all: an expired login
        // is better heard about before a clone than after it.
        report(`Finding ${label}…`);
        ensureStorage(root);
        const ready = provider.checkReady(abort.signal).then(
          () => undefined,
          (e: unknown) => e,
        );
        // A bare number is looked up in the workspace's repository; anything else from a neutral folder.
        const pr = await viewPullRequest({ gh, cwd: input.kind === 'number' && workspaceRoot ? workspaceRoot : root, signal: abort.signal }, input);
        if (!isCurrent()) return;
        // Re-run and Retry go to this pull request by its URL from now on.
        const byUrl: PullRequestInput = { kind: 'url', host: pr.host, owner: pr.owner, repo: pr.repo, number: pr.number, url: pr.url };
        this.lastPullRequest = { input: byUrl, workspaceRoot };
        this.lastAttempt = () => this.startPullRequest(byUrl, workspaceRoot);
        this.log.info(`pull request ${prLabel(pr)}: ${pr.state}${pr.isDraft ? ' (draft)' : ''}, ${headLabel(pr)} → ${pr.baseRefName} at ${pr.headRefOid.slice(0, 7)}`);
        steps.done(PR_STEP.find, prSummary(pr));
        message = pr.title;
        detail = `${prLabel(pr)} · ${headLabel(pr)} → ${pr.baseRefName}`;
        if (this.panel.webviewPanel) this.panel.webviewPanel.title = `Filos: ${pr.title}`;
        const notReady = await ready;
        if (notReady !== undefined) {
          // Only answers that settle the matter stop us (as in runAgent); the real run classifies the rest.
          if (notReady instanceof ProviderError && ['notInstalled', 'authExpired', 'cancelled'].includes(notReady.kind)) throw notReady;
          this.log.warn(`readiness check inconclusive: ${errorText(notReady)}`);
        }
        if (!isCurrent()) return;

        // 2. Get the code: Filos's own blobless clone, a fetch, a worktree at the head.
        steps.start(PR_STEP.code);
        show();
        const checkout = await prepareCheckout(pr, {
          gh,
          root,
          signal: abort.signal,
          onProgress: (_stage, text) => {
            if (!isCurrent()) return;
            steps.detail(PR_STEP.code, text);
            show();
            report(`${text.charAt(0).toUpperCase()}${text.slice(1)}…`);
          },
          log: (m) => this.log.warn(`pull request checkouts: ${m}`),
        });
        // Released below unless the review takes it over.
        unadopted = checkout.lease;
        if (!isCurrent()) return;
        this.log.info(`pull request code: ${checkout.cloned ? 'cloned' : 'fetched'} into ${checkout.repoDir}; worktree ${checkout.worktree}${checkout.reusedWorktree ? ' (reused)' : ''}`);
        steps.detail(PR_STEP.code, 'computing the diff');
        show();
        const diff = await pullRequestDiff(pr, checkout, abort.signal);
        if (!isCurrent()) return;
        if (!diff.trim()) throw new PrError(`${prLabel(pr)} changes nothing compared with ${safeProgressText(pr.baseRefName, 80)}, so there is nothing to review.`, 'empty');
        steps.done(PR_STEP.code, `${checkout.headOid.slice(0, 7)} · ${checkout.cloned ? 'cloned' : checkout.reusedWorktree ? 'already here' : 'fetched'}`);

        const warnings = [...checkout.warnings, ...git.diffWarnings(diff)];
        if (pr.isDraft) warnings.push('This pull request is a draft: its author may still be changing it.');
        if (pr.state !== 'OPEN') warnings.push(`This pull request is ${pr.state === 'MERGED' ? 'merged' : 'closed'}. Review it to learn the code; Filos won't post to it.`);
        // The index comes from where the PR branched off: the head's copy is the author's to write.
        const index = checkout.dependencyIndex;
        if (index.warning) warnings.push(index.warning);
        if (diffTouchesIndex(diff)) {
          warnings.push(`This pull request changes ${DEP_INDEX.split(sep).join('/')}, the dependency index. Filos used the index as it was where the pull request branched off, not the pull request's version: review that change yourself.`);
        }

        // The review proper: this pull request, at the commit just checked out.
        const target: ReviewTarget = {
          kind: 'pr',
          repoRoot: checkout.worktree,
          base: pr.baseRefName,
          head: headLabel(pr),
          prTitle: pr.title,
          pr: { url: pr.url, host: pr.host, owner: pr.owner, repo: pr.repo, number: pr.number },
        };
        steps.start(PR_STEP.read, 'starting');
        session = this.startSession(target, repoKeyFor('pr', checkout.worktree, `https://${pr.host}/${pr.owner}/${pr.repo}`), { reveal: false, loading: { message, detail, steps: steps.snapshot() } });
        // The session holds the worktree now: other windows leave it alone until it ends.
        this.lease = checkout.lease;
        unadopted = undefined;
        session.diff = diff;
        session.headOid = checkout.headOid;
        session.dependencyIndex = index.text;
        session.knownPullRequest = { ok: true, pr: toPullRequest(pr, checkout.headOid) };

        // 3. The comprehension pass.
        const result = await provider.comprehend({
          repoRoot: checkout.worktree,
          diff,
          base: pr.baseRefName,
          head: headLabel(pr),
          prTitle: pr.title,
          prDescription: pr.body,
          dependencyIndex: index.text,
          signal: abort.signal,
          onProgress: (text) => {
            if (!isCurrent()) return;
            const m = safeProgressText(text);
            this.log.info(`agent: ${m}`);
            steps.detail(PR_STEP.read, m);
            show();
            report(m);
          },
        });
        if (!isCurrent()) return;
        const cost = result.costUsd !== undefined ? `, $${result.costUsd.toFixed(3)}` : '';
        this.log.info(`agent finished in ${Math.round((result.durationMs ?? Date.now() - started) / 1000)} s${cost}`);
        steps.done(PR_STEP.read);
        // 4. Questions: ReviewState starts them with the graph and shows their progress itself.
        steps.start(PR_STEP.questions);
        // Facts the host owns: where the pull request is and who wrote it (shown in the header).
        result.graph.pr = { ...result.graph.pr, url: pr.url, ...(pr.author ? { author: pr.author } : {}) };
        this.loadGraph(session, result.graph, 'agent', [...warnings, ...result.warnings]);
      });
    } catch (e) {
      if (!isCurrent()) return; // superseded or closed: that one owns the view now
      const view = this.describePullRequestError(e, provider, cfg, e instanceof ProviderError ? PR_STEP.read : (steps.active ?? PR_STEP.find));
      steps.fail(e instanceof ProviderError ? PR_STEP.read : undefined);
      const kind = e instanceof PrError || e instanceof ProviderError ? e.kind : 'unexpected';
      this.log.error(`pull request ${label} (${kind}): ${errorText(e)}${(e instanceof PrError || e instanceof ProviderError) && e.detail ? `\n${e.detail}` : ''}`);
      this.fail(session, view.message, view.actions, view.detail, steps.snapshot());
    } finally {
      if (this.agentRun === abort) this.agentRun = undefined;
      // The code was fetched, but no review of it started (a failure, an empty diff, a newer review).
      unadopted?.release();
    }
  }

  /**
   * What the error view says about a failed pull request review, and which login "Log in again"
   * opens. `step` is the step that was running: an error that is neither gh's nor the agent's (a
   * bug, say) is described as Filos failing at that step, not as the agent failing.
   */
  private describePullRequestError(e: unknown, provider: AgentProvider, cfg: ProviderConfig, step: number): ErrorView {
    if (e instanceof PrError) {
      this.loginFor = { kind: 'gh', host: e.host };
      if (e.kind === 'cancelled') return { message: 'The review was cancelled.', actions: ['retry'] };
      const detail = e.detail?.trim() ? e.detail.slice(-4000) : undefined;
      return { message: e.message, detail, actions: e.kind === 'ghAuth' ? ['login', 'retry'] : ['retry'] };
    }
    if (!(e instanceof ProviderError)) {
      this.loginFor = { kind: 'agent' };
      const what = PR_STEP_WHAT[step] ?? 'reviewing the pull request';
      return { message: `Something went wrong in Filos while ${what}: ${safeProgressText(errorText(e), 200)}`, detail: e instanceof Error ? (e.stack ?? e.message) : String(e), actions: ['retry'] };
    }
    this.loginFor = { kind: 'agent' };
    const view = describeAgentError(e, { providerName: provider.displayName, loginCommand: provider.loginCommand, claudePath: cfg.claudePath, timeoutSeconds: cfg.timeoutSeconds, maxBudgetUsd: cfg.maxBudgetUsd });
    // "Show sample instead" only helps when the agent can't run at all: then the sample shows what Filos does.
    const keepSample = e instanceof ProviderError && e.kind === 'notInstalled';
    return { ...view, actions: view.actions.filter((a) => a !== 'useFixture' || keepSample) };
  }

  /** `gh auth login` in a terminal, run directly (no shell), from home: gh's own flow, Filos sees nothing. */
  private openGhLoginTerminal(host?: string): void {
    let gh: string;
    try {
      gh = readGhPath();
    } catch (e) {
      void vscode.window.showErrorMessage(`Filos: ${safeProgressText(errorText(e), 240)}`);
      return;
    }
    const name = 'Filos: GitHub login';
    const running = vscode.window.terminals.find((t) => t.name === name && t.exitStatus === undefined);
    if (running) {
      running.show();
      return;
    }
    const shellPath = resolveCommand(gh);
    if (!shellPath) {
      void vscode.window.showErrorMessage(`Filos: can't find the GitHub CLI ("${safeProgressText(gh, 120)}") on PATH. Install it, or set "filos.gh.path".`);
      return;
    }
    const args = ['auth', 'login', ...(host && HOST.test(host) ? ['--hostname', host] : [])];
    const terminal = vscode.window.createTerminal({ name, shellPath, shellArgs: args, cwd: homedir() });
    terminal.show();
    this.log.info(`opened "${name}" terminal: ${gh} ${args.join(' ')}`);
  }

  /**
   * Login happens in the user's own terminal, with the CLI's own flow: Filos never sees credentials.
   * The terminal runs the CLI directly rather than typing a command into a shell, so no shell
   * (PowerShell in particular) has to parse a path with spaces.
   */
  private openLoginTerminal(target: LoginTarget): void {
    if (target.kind === 'gh') {
      this.openGhLoginTerminal(target.host);
      return;
    }
    let provider: AgentProvider;
    try {
      provider = this.lastProvider ?? createProvider(readProviderConfig());
    } catch (e) {
      void vscode.window.showErrorMessage(`Filos: ${e instanceof Error ? e.message : String(e)}`);
      return;
    }
    const name = 'Filos login';
    const running = vscode.window.terminals.find((t) => t.name === name && t.exitStatus === undefined);
    if (running) {
      running.show();
      return;
    }
    const { command, args } = provider.login;
    const shellPath = resolveCommand(command);
    if (!shellPath) {
      void vscode.window.showErrorMessage(`Filos: can't find the ${provider.displayName} CLI ("${command}") on PATH. Install it, or set "filos.claude.path".`);
      return;
    }
    // Home, not the repo under review, so nothing in the PR's checkout can shape the login.
    const terminal = vscode.window.createTerminal({ name, shellPath, shellArgs: [...args], cwd: homedir() });
    terminal.show();
    this.log.info(`opened "${name}" terminal: ${provider.loginCommand}`);
  }

  /** Lets other windows tidy the worktree this window was reviewing. */
  private releaseLease(): void {
    this.lease?.release();
    this.lease = undefined;
  }

  private onPanelClosed(): void {
    // Closing the panel ends the review: stop any agent run (it costs money) and drop the folds.
    this.cancelAgent();
    this.endReview();
    this.releaseLease();
    this.codePane.setSession(undefined);
    this.session = undefined;
    this.folding.refresh();
  }

  dispose(): void {
    this.cancelAgent();
    this.endReview();
    this.releaseLease();
    this.panel.dispose();
    this.codePane.dispose();
    this.folding.dispose();
  }
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Head-revision reader for validation, confined to the repo. */
function repoReader(root: string): (path: string) => string | undefined {
  return (p) => {
    const abs = resolve(root, p);
    if (isAbsolute(p) || !abs.startsWith(root + sep)) return undefined;
    try {
      return readFileSync(abs, 'utf8');
    } catch {
      return undefined;
    }
  };
}

/** Local and remote-tracking branches, the detected default first (and preselected). */
async function pickBase(root: string, head: string): Promise<string | undefined> {
  const detected = await git.defaultBaseRef(root);
  const all = (await git.branches(root)).filter((b) => b !== head);
  const ordered = detected && all.includes(detected) ? [detected, ...all.filter((b) => b !== detected)] : all;
  if (!ordered.length) {
    void vscode.window.showErrorMessage(`Filos: ${head} is the only branch, so there is nothing to compare it with.`);
    return undefined;
  }
  const items: vscode.QuickPickItem[] = ordered.map((b) => ({ label: b, description: b === detected ? 'detected default' : undefined }));
  const picked = await vscode.window.showQuickPick(items, { title: `Filos: review ${head} against which base branch?`, placeHolder: 'Base branch (committed changes since the merge base are reviewed)' });
  return picked?.label;
}

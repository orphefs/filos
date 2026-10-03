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
import type { ErrorAction, GraphSource, HostToWebview, ReviewAction, WebviewToHost } from '../protocol';
import type { ReviewSnapshot } from '../review/types';
import { CodePane } from './codePane';
import { readGhPath, readProviderConfig } from './config';
import { repoKeyFor } from './confidenceStore';
import { readDependencyIndex } from './depIndex';
import { describeAgentError } from './errors';
import { OutlineFoldingProvider } from './folding';
import * as git from './git';
import { detectPullRequest, type PullRequestLookup } from './github';
import { ReviewPanel } from './panel';
import { ReviewState } from './reviewState';
import { materialiseSample, type SampleRepo } from './sample';
import { ReviewSession, type RenderedInfo, type ReviewTarget } from './session';

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
  private agentRun?: AbortController;
  private lastProvider?: AgentProvider;
  private waiters: RenderWaiter[] = [];
  /** Questionnaire, comments and didactic state of the loaded graph. */
  private review?: ReviewState;
  /**
   * Tests answer the posting confirmation themselves (a modal would block the test run).
   * Undefined: the real modal.
   */
  confirmOverride?: (message: string, detail: string) => boolean;

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
    let base = options.base ?? (options.pickBase ? undefined : await git.defaultBaseRef(root));
    if (!base) {
      base = await pickBase(root, head);
      if (!base) return;
      // Re-run and Retry keep the chosen base rather than asking again.
      const chosen = { base };
      this.lastBranchOptions = chosen;
      this.lastAttempt = () => this.reviewCurrentBranch(chosen);
    }
    if (!(await git.mergeBase(root, base, 'HEAD'))) {
      void vscode.window.showErrorMessage(`Filos: ${head} and ${base} have no common history to compare.`);
      return;
    }
    const diff = await git.diff(root, base, 'HEAD');
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
    const subjects = await git.commitSubjects(root, base, 'HEAD');
    const prTitle = subjects.length === 1 ? subjects[0] : head;
    const repoRoot = realpathSync(root);
    const repoKey = repoKeyFor('branch', repoRoot, await git.originUrl(root));

    this.cancelAgent();
    const session = this.startSession({ kind: 'branch', repoRoot, base, head, prTitle }, repoKey);
    session.diff = diff;
    session.dependencyIndex = index.text;
    // gh takes a second or two; the agent takes minutes. Look the PR up while it works.
    session.pullRequest = this.lookUpPullRequest(repoRoot);
    await this.runAgent(session, { diff, dependencyIndex: index.text, note, warnings });
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
        this.openLoginTerminal();
        return;
      case 'retry':
        await (this.lastAttempt ?? (() => this.reviewSample()))();
        return;
      case 'useFixture':
        await this.reviewSample();
        return;
      case 'rerun':
        if (this.session?.target.kind === 'branch') await this.reviewCurrentBranch(this.lastBranchOptions);
        else await this.reviewSampleWithAgent();
        return;
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

  private startSession(target: ReviewTarget, repoKey?: string): ReviewSession {
    this.endReview();
    const session = new ReviewSession(target, this.context.workspaceState, repoKey ?? (target.kind === 'sample' ? repoKeyFor('sample', target.repoRoot) : target.repoRoot));
    if (this.session) session.inheritOutlines(this.session);
    this.session = session;
    this.codePane.setSession(session);
    this.folding.refresh();
    this.panel.open(target.prTitle);
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
        openLogin: () => this.openLoginTerminal(),
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
    if (!existsSync(uri.fsPath)) return;
    vscode.workspace.openTextDocument(uri).then(
      () => this.log.debug(`warmed up ${first.file}`),
      (e: unknown) => this.log.debug(`warm-up skipped: ${String(e)}`),
    );
  }

  private setLoading(session: ReviewSession, message: string, detail?: string): void {
    if (this.session !== session) return;
    session.setLoading(message, detail);
    this.post(session.snapshot());
  }

  private fail(session: ReviewSession, message: string, actions: ErrorAction[], detail?: string): void {
    this.log.error(`${message}${detail ? `\n${detail}` : ''}`);
    if (this.session !== session) return;
    session.setError(message, actions, detail);
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

  /**
   * Login happens in the user's own terminal, with the CLI's own flow: Filos never sees credentials.
   * The terminal runs the CLI directly rather than typing a command into a shell, so no shell
   * (PowerShell in particular) has to parse a path with spaces.
   */
  private openLoginTerminal(): void {
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

  private onPanelClosed(): void {
    // Closing the panel ends the review: stop any agent run (it costs money) and drop the folds.
    this.cancelAgent();
    this.endReview();
    this.codePane.setSession(undefined);
    this.session = undefined;
    this.folding.refresh();
  }

  dispose(): void {
    this.cancelAgent();
    this.endReview();
    this.panel.dispose();
    this.codePane.dispose();
    this.folding.dispose();
  }
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

// Orchestrates a review: picks the repo and range, gets a graph (bundled fixture or agent), keeps
// the session, and routes webview messages to the code pane. The only place that knows all parts.

import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve, sep } from 'node:path';
import * as vscode from 'vscode';
import { createProvider, ProviderError, type AgentProvider, type ProviderConfig } from '../agent';
import type { ReviewGraph } from '../contract/graph';
import { validateGraph } from '../contract/validate';
import type { ErrorAction, GraphSource, HostToWebview, WebviewToHost } from '../protocol';
import { CodePane } from './codePane';
import { describeAgentError } from './errors';
import { OutlineFoldingProvider } from './folding';
import * as git from './git';
import { ReviewPanel } from './panel';
import { materialiseSample, type SampleRepo } from './sample';
import { ReviewSession, type RenderedInfo, type ReviewTarget } from './session';

const DEP_INDEX = join('.filos', 'dependency-index.json');
const MAX_DEP_INDEX_BYTES = 5 * 1024 * 1024;

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
    const index = readDependencyIndex(repo.repoRoot);
    await this.runAgent(session, { diff, dependencyIndex: index.text, note: `Comparing ${repo.head} with ${repo.base}`, warnings: index.warning ? [index.warning] : [] });
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

    const warnings: string[] = [];
    let note = `Comparing ${head} with ${base}`;
    if (await git.hasUncommittedChanges(root)) {
      note += ' · uncommitted changes are ignored';
      warnings.push(`Only committed changes are reviewed: ${head} has uncommitted changes that are not in this graph.`);
    }
    const index = readDependencyIndex(root);
    if (index.warning) warnings.push(index.warning);
    const subjects = await git.commitSubjects(root, base, 'HEAD');
    const prTitle = subjects.length === 1 ? subjects[0] : head;

    this.cancelAgent();
    const session = this.startSession({ kind: 'branch', repoRoot: realpathSync(root), base, head, prTitle });
    await this.runAgent(session, { diff, dependencyIndex: index.text, note, warnings });
  }

  // ---- selection ------------------------------------------------------------------------------

  /** Same path as a click in the graph. */
  select(id: string, anchorIndex?: number): Promise<void> {
    const s = this.session;
    if (!s?.graph) return Promise.resolve();
    return this.codePane.show(id, anchorIndex);
  }

  /** Host-driven selection (tests, commands): move the graph's selection too. */
  selectFromHost(id: string): Promise<void> {
    this.post({ type: 'select', id });
    return this.select(id);
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
        void this.handleAction(msg.action).catch((e: unknown) => this.log.error(`action ${msg.action}: ${String(e)}`));
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
    }
  }

  private startSession(target: ReviewTarget): ReviewSession {
    const session = new ReviewSession(target, this.context.workspaceState);
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
    this.warmUp(session, graph);
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
    this.cancelAgent();
    const cfg = readProviderConfig();
    let provider: AgentProvider;
    try {
      provider = createProvider({ ...cfg, onRawLine: (line) => this.log.trace(`[cli] ${line.length > 2000 ? line.slice(0, 2000) + '…' : line}`) });
    } catch (e) {
      this.fail(session, 'Filos could not set up the agent.', ['useFixture'], e instanceof Error ? e.message : String(e));
      return;
    }
    this.lastProvider = provider;
    const abort = new AbortController();
    this.agentRun = abort;
    const isCurrent = () => this.agentRun === abort && this.session === session;
    const progressTo = (report: (m: string) => void) => (message: string) => {
      if (!isCurrent()) return;
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

  /** Login happens in the user's own terminal, with the CLI's own flow: Filos never sees credentials. */
  private openLoginTerminal(): void {
    let command: string;
    try {
      command = (this.lastProvider ?? createProvider(readProviderConfig())).loginCommand;
    } catch (e) {
      void vscode.window.showErrorMessage(`Filos: ${e instanceof Error ? e.message : String(e)}`);
      return;
    }
    const name = 'Filos login';
    const terminal = vscode.window.terminals.find((t) => t.name === name && t.exitStatus === undefined) ?? vscode.window.createTerminal({ name });
    terminal.show();
    terminal.sendText(command);
    this.log.info(`opened "${name}" terminal: ${command}`);
  }

  private onPanelClosed(): void {
    // Closing the panel ends the review: stop any agent run (it costs money) and drop the folds.
    this.cancelAgent();
    this.codePane.setSession(undefined);
    this.session = undefined;
    this.folding.refresh();
  }

  dispose(): void {
    this.cancelAgent();
    this.panel.dispose();
    this.codePane.dispose();
    this.folding.dispose();
  }
}

function readProviderConfig(): ProviderConfig {
  const c = vscode.workspace.getConfiguration('filos');
  const id = c.get<string>('provider', 'claude');
  return {
    id: id as ProviderConfig['id'],
    claudePath: resolveExecutable(c.get<string>('claude.path', 'claude')),
    model: c.get<string>('claude.model', 'sonnet') || undefined,
    maxBudgetUsd: c.get<number>('claude.maxBudgetUsd', 1),
    timeoutSeconds: c.get<number>('agentTimeoutSeconds', 600),
  };
}

/** "~/bin/claude" and workspace-relative paths ("./node_modules/.bin/claude") work as users expect. */
function resolveExecutable(p: string): string {
  const v = p.trim() || 'claude';
  if (v === '~' || v.startsWith('~/')) return join(homedir(), v.slice(1));
  if (isAbsolute(v) || !/[\\/]/.test(v)) return v;
  const folder = vscode.workspace.workspaceFolders?.[0];
  return folder ? resolve(folder.uri.fsPath, v) : v;
}

function readDependencyIndex(root: string): { text?: string; warning?: string } {
  const file = join(root, DEP_INDEX);
  try {
    if (!existsSync(file)) return {};
    const size = statSync(file).size;
    if (size > MAX_DEP_INDEX_BYTES) return { warning: `${DEP_INDEX} is ${Math.round(size / 1024 / 1024)} MB, over the 5 MB limit, so it was not used.` };
    return { text: readFileSync(file, 'utf8') };
  } catch (e) {
    return { warning: `${DEP_INDEX} could not be read: ${e instanceof Error ? e.message : String(e)}` };
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

async function pickBase(root: string, head: string): Promise<string | undefined> {
  const branches = (await git.localBranches(root)).filter((b) => b !== head);
  if (!branches.length) {
    void vscode.window.showErrorMessage(`Filos: ${head} is the only branch, so there is nothing to compare it with.`);
    return undefined;
  }
  return vscode.window.showQuickPick(branches, { title: `Filos: review ${head} against which base branch?`, placeHolder: 'Base branch (committed changes since the merge base are reviewed)' });
}

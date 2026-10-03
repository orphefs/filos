// Hooks for the e2e suite, so tests can drive and observe the host without poking the webview's
// DOM. Exposed from activate() only in development and test runs.

import type * as vscode from 'vscode';
import type { Region } from '../contract/graph';
import type { ErrorAction, ReviewAction } from '../protocol';
import type { ReviewSnapshot } from '../review/types';
import type { CodePaneSnapshot } from './codePane';
import { parseWebviewMessage, REVIEW_ACTION_TYPES } from './panel';
import type { ReviewController } from './review';
import type { PostRecord } from './reviewState';
import type { RenderedInfo, ReviewTarget, SessionStatus } from './session';

export interface SessionInfo {
  key: string;
  target: ReviewTarget;
  status: SessionStatus;
  source?: 'fixture' | 'agent';
  nodeIds: string[];
  warnings: string[];
  state: { expanded: string[]; visited: string[]; selected?: string };
}

export interface FilosTestApi {
  getSession(): SessionInfo | undefined;
  getLastRendered(): RenderedInfo | undefined;
  /** Resolves with the first "rendered" report (already received or upcoming) matching the predicate. */
  waitForRendered(predicate?: (r: RenderedInfo) => boolean, timeoutMs?: number): Promise<RenderedInfo>;
  /** Runs the same path as a click in the graph, and moves the graph's selection to match. */
  simulateSelect(id: string): Promise<void>;
  simulateOpenAnchor(id: string, anchorIndex: number): Promise<void>;
  simulateAction(action: ErrorAction | 'rerun'): Promise<void>;
  getPanel(): vscode.WebviewPanel | undefined;
  isWebviewReady(): boolean;
  getCodePane(): CodePaneSnapshot;
  /** Regions Filos folded in this file for the current selection (empty for other files). */
  getFoldedRegions(uri: vscode.Uri): Region[];

  /** The questionnaire/comments/didactic snapshot the webview was last sent (undefined before a graph loads). */
  getReviewSnapshot(): ReviewSnapshot | undefined;
  /**
   * Applies a ReviewAction exactly as a webview message would be (same validation, same handling).
   * Resolves once any agent call or post it started has finished. Throws for a malformed action.
   */
  dispatchReviewAction(action: ReviewAction): Promise<void>;
  /** Resolves when background review work (questions, PR lookup, agent calls) has finished. */
  waitForReviewIdle(): Promise<void>;
  /**
   * Answers the posting confirmation instead of the modal (which would block a test run):
   * true = "Post review", false = cancel, undefined = show the real modal again.
   */
  setConfirmAnswer(answer: boolean | undefined): void;
  /** The text of the last posting confirmation. */
  getLastConfirmation(): { message: string; detail: string } | undefined;
  /** What the last post sent to `gh api` (argv and JSON payload), and how it ended. */
  getLastPost(): PostRecord | undefined;
  /** The Markdown of the last Export. */
  getLastExport(): string | undefined;
  /** Everything Filos keeps in globalState, by key (the mode, the private confidence store, pull request reviews). */
  getGlobalState(): Record<string, unknown>;
  /** The keys Filos keeps in each store: pull request reviews are global, branch and sample reviews per workspace. */
  getStoredKeys(): { global: string[]; workspace: string[] };
  /**
   * Forgets every stored review (answers, comments, progress), every view state, the mode and the
   * confidence store, so a suite starts clean. Takes effect for the next review opened.
   */
  resetStoredState(): Promise<void>;
}

/** Where review state is kept: branch and sample reviews in workspaceState; pull request reviews, mode and confidence in globalState. */
type Stores = Pick<vscode.ExtensionContext, 'globalState' | 'workspaceState'>;

export function createTestApi(c: ReviewController, stores: Stores): FilosTestApi {
  return {
    getSession() {
      const s = c.currentSession;
      if (!s) return undefined;
      return { key: s.key, target: s.target, status: s.status, source: s.source, nodeIds: s.graph?.nodes.map((n) => n.id) ?? [], warnings: s.warnings, state: s.state };
    },
    getLastRendered: () => c.currentSession?.lastRendered,
    waitForRendered: (predicate, timeoutMs) => c.waitForRendered(predicate, timeoutMs),
    simulateSelect: (id) => c.selectFromHost(id),
    simulateOpenAnchor: (id, i) => c.select(id, i),
    simulateAction: (a) => c.handleAction(a),
    getPanel: () => c.webviewPanel,
    isWebviewReady: () => c.webviewReady,
    getCodePane: () => c.codePane.snapshot(),
    getFoldedRegions(uri) {
      const snap = c.codePane.snapshot();
      return snap.uri === uri.toString() ? snap.folded : [];
    },
    getReviewSnapshot: () => c.currentReview?.model.snapshot(),
    async dispatchReviewAction(action) {
      const msg = parseWebviewMessage(action);
      if (!msg || !REVIEW_ACTION_TYPES.has(msg.type)) throw new Error(`not a valid review action: ${JSON.stringify(action)}`);
      await c.applyReviewAction(msg as ReviewAction);
    },
    waitForReviewIdle: async () => {
      await c.currentReview?.idle();
      await c.currentSession?.pullRequest;
    },
    setConfirmAnswer(answer) {
      c.confirmOverride = answer === undefined ? undefined : () => answer;
    },
    getLastConfirmation: () => c.currentReview?.lastConfirmation,
    getLastPost: () => c.currentReview?.lastPost,
    getLastExport: () => c.currentReview?.lastExport,
    getGlobalState: () => Object.fromEntries(stores.globalState.keys().map((k) => [k, stores.globalState.get(k)])),
    getStoredKeys: () => ({ global: [...stores.globalState.keys()], workspace: [...stores.workspaceState.keys()] }),
    async resetStoredState() {
      for (const k of stores.workspaceState.keys()) if (/^filos\.(review|viewState):/.test(k)) await stores.workspaceState.update(k, undefined);
      for (const k of stores.globalState.keys()) await stores.globalState.update(k, undefined);
    },
  };
}

// Hooks for the e2e suite, so tests can drive and observe the host without poking the webview's
// DOM. Exposed from activate() only in development and test runs.

import type * as vscode from 'vscode';
import type { Region } from '../contract/graph';
import type { ErrorAction } from '../protocol';
import type { CodePaneSnapshot } from './codePane';
import type { ReviewController } from './review';
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
}

export function createTestApi(c: ReviewController): FilosTestApi {
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
  };
}

// The webview side of the VS Code API. acquireVsCodeApi may be called only once per page.

import type { ViewState, WebviewToHost } from '../protocol';
import type { PaneTab } from './paneContext';

/** What we keep in the webview's own state, so a hidden/restored panel comes back as it was. */
export interface PersistedState {
  v: 1;
  /** Identifies the graph the view state belongs to. */
  key: string;
  view: ViewState;
  /** The side pane's tab, whatever the PR. */
  tab?: PaneTab;
}

interface VsCodeApi {
  postMessage(msg: unknown): void;
  getState(): unknown;
  setState(state: unknown): unknown;
}

declare global {
  interface Window {
    acquireVsCodeApi?: () => VsCodeApi;
  }
}

const api: VsCodeApi = window.acquireVsCodeApi?.() ?? {
  // Outside VS Code (and without the harness mock) messages just go to the console.
  postMessage: (msg) => console.info('[filos → host]', msg),
  getState: () => undefined,
  setState: (s) => s,
};

export function post(msg: WebviewToHost): void {
  api.postMessage(msg);
}

export function loadPersisted(): PersistedState | undefined {
  const s = api.getState() as Partial<PersistedState> | undefined;
  return s && s.v === 1 && typeof s.key === 'string' && s.view ? (s as PersistedState) : undefined;
}

export function savePersisted(state: PersistedState): void {
  api.setState(state);
}

const TABS: readonly string[] = ['summary', 'questions', 'comments'];

/** The side pane tab last shown, from any PR. */
export function loadTab(): PaneTab | undefined {
  const s = api.getState() as Partial<PersistedState> | undefined;
  return s && typeof s.tab === 'string' && TABS.includes(s.tab) ? s.tab : undefined;
}

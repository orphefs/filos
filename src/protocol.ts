// Messages between the extension host and the review webview.

import type { ReviewGraph } from './contract/graph';

export type GraphSource = 'fixture' | 'agent';

export interface ViewState {
  /** Node ids whose children are shown. */
  expanded: string[];
  selected?: string;
  /** Node ids the user has opened at least once (drives "you've looked at this" cues). */
  visited: string[];
}

export type HostToWebview =
  | { type: 'loading'; message: string; detail?: string }
  | { type: 'load'; graph: ReviewGraph; source: GraphSource; state: ViewState; warnings: string[] }
  | { type: 'error'; message: string; detail?: string; actions: ErrorAction[] }
  /** Host-driven selection, e.g. from a test or a command. */
  | { type: 'select'; id: string };

export type ErrorAction = 'login' | 'retry' | 'useFixture';

export type WebviewToHost =
  | { type: 'ready' }
  /** User selected a node: host opens its code in the editor beside the graph. */
  | { type: 'select'; id: string }
  /** Open a specific anchor of a node (e.g. second file of a module). */
  | { type: 'openAnchor'; id: string; anchorIndex: number }
  | { type: 'stateChanged'; state: ViewState }
  | { type: 'action'; action: ErrorAction | 'rerun' }
  /** Sent after every render, so the host (and tests) know what the user can see. */
  | { type: 'rendered'; visibleNodes: string[]; expanded: string[]; selected?: string };

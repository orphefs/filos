// Messages between the extension host and the review webview.

import type { ReviewGraph } from './contract/graph';
import type { Depth } from './contract/questions';
import type { Familiarity, Mode, ReviewSnapshot } from './review/types';

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
  | { type: 'select'; id: string }
  /** Full questionnaire/comments/didactic state; sent after 'load' and after every change. */
  | { type: 'review'; review: ReviewSnapshot };

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
  | { type: 'rendered'; visibleNodes: string[]; expanded: string[]; selected?: string }
  | ReviewAction;

/** Questionnaire, comments and didactic-mode actions. The host applies them and replies with a 'review' snapshot. */
export type ReviewAction =
  | { type: 'setMode'; mode: Mode }
  | { type: 'setDepth'; depth: Depth }
  /** Didactic: start entering a fogged territory (opens its gate). */
  | { type: 'enter'; nodeId: string }
  | { type: 'familiarity'; nodeId: string; level: Familiarity }
  /** Leave the gate without entering. */
  | { type: 'cancelGate' }
  | { type: 'answer'; questionId: string; choiceId?: string; text?: string }
  /** Open answer without an agent: the reviewer compares it with the reference. */
  | { type: 'selfCheck'; questionId: string; gotIt: boolean }
  | { type: 'commentAction'; id: string; action: 'accept' | 'reject' | 'reopen' }
  | { type: 'amend'; id: string; body: string }
  | { type: 'thread'; id: string; text: string }
  /** Adopt the proposal of thread message `index` as the comment body. */
  | { type: 'adoptProposal'; id: string; index: number }
  /** Free-text escape hatch: a reviewer note becomes a draft comment. */
  | { type: 'addNote'; text: string; nodeId?: string }
  /** Ask the agent to draft comments from the answers so far. */
  | { type: 'draftWithAgent' }
  | { type: 'post' }
  | { type: 'exportReview' };

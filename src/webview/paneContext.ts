// What the question and comment cards need to render and act: the latest review snapshot, the graph,
// the fog, half-typed drafts, pane-local UI state, and callbacks into the app. Agent and PR text is
// untrusted: cards set it with textContent only (via h()), never as HTML.

import type { GraphNode } from '../contract/graph';
import type { Question } from '../contract/questions';
import type { ReviewAction } from '../protocol';
import type { GraphIndex } from '../review/order';
import type { DraftComment, ReviewSnapshot } from '../review/types';
import { h } from './dom';
import type { Drafts } from './drafts';
import type { Fog } from './fog';
import type { Model } from './model';

export type PaneTab = 'summary' | 'questions' | 'comments';

/** Pane-local state: survives snapshots, not reloads (except the tab, kept in webview state). */
export interface PaneUi {
  tab: PaneTab;
  /** Done question cards the reviewer opened, or just answered (their feedback stays in view). */
  openCards: Set<string>;
  /** Comments whose discussion is shown. */
  openThreads: Set<string>;
  /** Comments being amended. */
  amending: Set<string>;
  /** Questions tab: all questions instead of the selected node's. */
  showAll: boolean;
  /**
   * Comments seen posted in this session: the ones accepted when Post was clicked, once the host
   * reports 'posted'. Stands in until snapshots carry DraftComment.posted.
   */
  postedIds: Set<string>;
  postingIds?: string[];
}

export interface PaneContext {
  review: ReviewSnapshot;
  model: Model;
  index: GraphIndex;
  fog: Fog;
  drafts: Drafts;
  ui: PaneUi;
  selected?: string;
  /** Post a review action; focus moves to the first of `focusNext` that exists after the next render. */
  act(action: ReviewAction, focusNext?: string[]): void;
  /** Re-render the pane now (pane-local state changed). */
  rerender(focusNext?: string[]): void;
  /** Select a node from the pane (reveals it in the graph and opens its code). */
  selectNode(id: string): void;
  /** Didactic: open the gate into a territory. */
  enter(id: string): void;
  /** Switch to the Comments tab and focus a comment. */
  showComment(id: string): void;
  announce(text: string): void;
}

let seq = 0;
/** A fresh element id for aria wiring (question and comment ids are untrusted, so not used as ids). */
export function uid(prefix: string): string {
  return `${prefix}-${++seq}`;
}

export function nodeLabel(ctx: Pick<PaneContext, 'model'>, id: string | undefined): string {
  if (id === undefined) return '';
  return ctx.model.byId.get(id)?.label ?? id;
}

const CODE_KINDS = new Set(['function', 'class', 'type']);

/** A node's name, in the code font for symbols. */
export function nodeName(node: GraphNode | undefined, fallback: string): HTMLElement {
  return h('span', { class: node && CODE_KINDS.has(node.kind) ? 'code-name' : 'plain-name' }, node?.label ?? fallback);
}

/** Whether a question can be answered now (didactic: not in fog, except the open gate's own question). */
export function answerable(ctx: PaneContext, q: Question): boolean {
  if (ctx.review.mode !== 'didactic') return !q.id.startsWith('gate:');
  const gate = ctx.review.gate;
  if (gate?.step === 'predict' && gate.questionId === q.id) return true;
  if (q.id.startsWith('gate:')) return false;
  const t = ctx.index.territoryOf(q.nodeId);
  if (t) return !ctx.fog.fogged.has(t);
  return !ctx.fog.dimmed.has(q.nodeId);
}

/** The comment a question drafted (latest first), if it still stands. */
export function commentFromQuestion(review: ReviewSnapshot, questionId: string): DraftComment | undefined {
  const mine = review.comments.filter((c) => c.origin.kind === 'question' && c.origin.questionId === questionId && c.status !== 'rejected');
  return mine[mine.length - 1];
}

/** Whether the comment was posted: the host's flag when it sends one (requested), else what this session saw. */
export function isPosted(c: DraftComment, ui: PaneUi): boolean {
  return (c as DraftComment & { posted?: boolean }).posted === true || ui.postedIds.has(c.id);
}

/**
 * The agent CLI the review's agent steps go to ("Claude Code", "Codex"), for sentences: the host's
 * name for it, else "the agent". `start` capitalises it for the start of a sentence.
 */
export function agentName(review: Pick<ReviewSnapshot, 'agentName'> | undefined, start = false): string {
  const raw = typeof review?.agentName === 'string' ? review.agentName.replace(/[\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, '').replace(/[\s\x00-\x1f\x7f]+/g, ' ').trim().slice(0, 40) : '';
  const name = raw || 'the agent';
  return start ? name.charAt(0).toUpperCase() + name.slice(1) : name;
}

/**
 * The agent CLI that wrote something (a reply, feedback, a draft), as stored with it when it was
 * written: switching CLI later doesn't relabel it. Older reviews stored none: "the agent".
 */
export function writtenBy(name: string | undefined, start = false): string {
  return agentName({ agentName: name }, start);
}

/** "Uses Codex · small cost": every button that calls the agent says so. */
export function costNote(id: string, review: Pick<ReviewSnapshot, 'agentName'> | undefined): HTMLElement {
  return h('span', { class: 'cost-note', id }, `Uses ${agentName(review)} · small cost`);
}

export function spinnerLine(text: string): HTMLElement {
  return h('p', { class: 'pending-line', role: 'status' }, h('span', { class: 'mini-spinner', 'aria-hidden': 'true' }), text);
}

/** A button wired for the pane: stable focus key, click handler, optional extra attributes. */
export function paneButton(label: string | (Node | null)[], focusKey: string, onClick: () => void, attrs: Record<string, string | number | boolean | undefined> = {}): HTMLButtonElement {
  const b = h('button', { type: 'button', 'data-focus-key': focusKey, ...attrs });
  if (typeof label === 'string') b.textContent = label;
  else b.append(...label.filter((n): n is Node => n !== null));
  b.addEventListener('click', (ev) => {
    ev.preventDefault();
    if (b.getAttribute('aria-disabled') === 'true') return;
    onClick();
  });
  return b;
}

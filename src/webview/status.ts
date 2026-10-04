// Full-pane states that replace the graph: waiting, loading (agent running) and error.
// A long start (a pull request: fetch it, prepare its code, the comprehension pass, questions)
// arrives as steps, shown as a checklist whose details update while the agent runs. Step text is
// sanitised by the host but still untrusted: it is set as text only, never as HTML.

import type { ErrorAction, LoadingStep } from '../protocol';
import { h } from './dom';

const ACTION_LABEL: Record<ErrorAction, string> = {
  login: 'Log in again',
  retry: 'Retry',
  useFixture: 'Show sample instead',
  chooseAgent: 'Choose agent…',
};

type StepState = LoadingStep['state'];

/** Each state has its own shape and words: colour only reinforces them. */
const STEP_STATE: Record<StepState, { icon: string; said: string }> = {
  done: { icon: '✓', said: 'Done' },
  active: { icon: '', said: 'In progress' },
  // Drawn as a hollow ring (CSS), like ○ but the same size in every font.
  pending: { icon: '', said: 'Not started' },
  failed: { icon: '✗', said: 'Failed' },
};

const MAX_STEPS = 12;
const MAX_LABEL = 120;
const MAX_DETAIL = 240;

/** One line, no control or direction-override characters (they could reorder what a label says), capped. */
function clip(text: string, max: number): string {
  const flat = text
    .replace(/[\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, '')
    .replace(/[\s\x00-\x1f\x7f]+/g, ' ')
    .trim();
  return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat;
}

/** The host's steps, checked: anything malformed is dropped rather than drawn. */
export function cleanSteps(steps: unknown): LoadingStep[] | undefined {
  if (!Array.isArray(steps)) return undefined;
  const out: LoadingStep[] = [];
  for (const s of steps.slice(0, MAX_STEPS)) {
    if (!s || typeof s !== 'object') continue;
    const { label, state, detail } = s as Partial<LoadingStep>;
    if (typeof label !== 'string' || !label.trim() || typeof state !== 'string' || !(state in STEP_STATE)) continue;
    const step: LoadingStep = { label: clip(label, MAX_LABEL), state };
    if (typeof detail === 'string' && detail.trim()) step.detail = clip(detail, MAX_DETAIL);
    out.push(step);
  }
  return out.length ? out : undefined;
}

/** One row of the checklist; `update` changes it in place so the active spinner never restarts. */
class StepRow {
  readonly el: HTMLLIElement;
  private readonly icon: HTMLElement;
  private readonly said: HTMLElement;
  private readonly label: HTMLElement;
  private readonly detail: HTMLElement;
  private state?: StepState;

  constructor(step: LoadingStep) {
    this.icon = h('span', { class: 'lstep-icon', 'aria-hidden': 'true' });
    this.said = h('span', { class: 'sr-only' });
    this.label = h('span', { class: 'lstep-label' });
    this.detail = h('span', { class: 'lstep-detail' });
    this.el = h('li', { class: 'lstep' }, this.icon, h('span', { class: 'lstep-text' }, h('span', { class: 'lstep-head' }, this.said, this.label), this.detail));
    this.update(step);
  }

  update(step: LoadingStep): void {
    if (step.state !== this.state) {
      this.state = step.state;
      this.el.className = `lstep lstep--${step.state}`;
      this.el.dataset.state = step.state;
      if (step.state === 'active') {
        this.el.setAttribute('aria-current', 'step');
        this.icon.replaceChildren(h('span', { class: 'mini-spinner' }));
      } else {
        this.el.removeAttribute('aria-current');
        this.icon.replaceChildren(STEP_STATE[step.state].icon);
      }
      this.said.textContent = `${STEP_STATE[step.state].said}: `;
    }
    if (this.label.textContent !== step.label) this.label.textContent = step.label;
    const detail = step.detail ?? '';
    if (this.detail.textContent !== detail) this.detail.textContent = detail;
    this.detail.hidden = !detail;
  }
}

/** The checklist of steps (an ordered list, so a screen reader says "2 of 4"). */
class StepList {
  readonly el: HTMLOListElement;
  private rows: StepRow[] = [];

  constructor(steps: LoadingStep[]) {
    this.el = h('ol', { class: 'lsteps', 'aria-label': 'Steps' });
    this.update(steps);
  }

  update(steps: LoadingStep[]): void {
    if (steps.length !== this.rows.length) {
      this.rows = steps.map((s) => new StepRow(s));
      this.el.replaceChildren(...this.rows.map((r) => r.el));
      return;
    }
    steps.forEach((s, i) => this.rows[i].update(s));
  }
}

/** What a screen reader hears about the steps: the step now running, or the one that failed. */
function stepNews(steps: LoadingStep[]): string {
  const failed = steps.findIndex((s) => s.state === 'failed');
  if (failed >= 0) return `Step ${failed + 1} of ${steps.length} failed: ${steps[failed].label}`;
  const active = steps.findIndex((s) => s.state === 'active');
  if (active >= 0) return `Step ${active + 1} of ${steps.length}: ${steps[active].label}`;
  return steps.every((s) => s.state === 'done') ? 'All steps done' : '';
}

/**
 * The loading view with steps. Updated in place as the host reports progress: the details change
 * live, and only a change of step is announced (not every line of agent progress).
 */
export class LoadingPanel {
  readonly el: HTMLElement;
  private readonly message: HTMLElement;
  private readonly detail: HTMLElement;
  private readonly list: StepList;
  private news = '';

  constructor(message: string, detail: string | undefined, steps: LoadingStep[]) {
    this.message = h('h2', { class: 'status-message' });
    this.detail = h('p', { class: 'status-detail' });
    this.list = new StepList(steps);
    this.el = h('div', { class: 'status status--loading status--steps', 'aria-busy': 'true' }, this.message, this.detail, this.list.el);
    this.setText(message, detail);
  }

  /** @returns what to announce: the step that started or failed, once per change */
  update(message: string, detail: string | undefined, steps: LoadingStep[]): string | undefined {
    this.setText(message, detail);
    this.list.update(steps);
    const news = stepNews(steps);
    if (news === this.news) return undefined;
    this.news = news;
    return news || undefined;
  }

  private setText(message: string, detail: string | undefined): void {
    if (this.message.textContent !== message) this.message.textContent = message;
    const d = detail ?? '';
    if (this.detail.textContent !== d) this.detail.textContent = d;
    this.detail.hidden = !d;
  }
}

export function loadingView(message: string, detail?: string): HTMLElement {
  return h(
    'div',
    { class: 'status status--loading', role: 'status', 'aria-live': 'polite', 'aria-busy': 'true' },
    h('div', { class: 'spinner', 'aria-hidden': 'true' }),
    h('h2', { class: 'status-message' }, message),
    detail ? h('p', { class: 'status-detail' }, detail) : null,
  );
}

/** With steps, they come first (the failed one marked), then the message and what to do about it. */
export function errorView(message: string, detail: string | undefined, actions: ErrorAction[], onAction: (a: ErrorAction) => void, steps?: LoadingStep[]): HTMLElement {
  const buttons = actions.map((a, i) => {
    // The first action is the one the host recommends.
    const b = h('button', { type: 'button', class: i === 0 ? 'primary' : 'secondary', 'data-action': a }, ACTION_LABEL[a] ?? a);
    b.addEventListener('click', () => onAction(a));
    return b;
  });
  return h(
    'div',
    { class: `status status--error${steps?.length ? ' status--steps' : ''}` },
    steps?.length ? new StepList(steps).el : null,
    // Only the message is the alert: the steps and details are there to read, not to be read out.
    h('div', { class: 'status-alert', role: 'alert' }, h('div', { class: 'status-icon', 'aria-hidden': 'true' }, '!'), h('h2', { class: 'status-message' }, message)),
    detail ? h('details', { class: 'status-details' }, h('summary', {}, 'Details'), h('pre', {}, detail)) : null,
    buttons.length ? h('div', { class: 'status-actions' }, ...buttons) : null,
  );
}

export function waitingView(): HTMLElement {
  return h('div', { class: 'status status--waiting', role: 'status' }, h('div', { class: 'spinner', 'aria-hidden': 'true' }), h('h2', { class: 'status-message' }, 'Waiting for the review…'));
}

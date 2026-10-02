// Full-pane states that replace the graph: waiting, loading (agent running) and error.

import type { ErrorAction } from '../protocol';
import { h } from './dom';

const ACTION_LABEL: Record<ErrorAction, string> = {
  login: 'Log in again',
  retry: 'Retry',
  useFixture: 'Show sample instead',
};

export function loadingView(message: string, detail?: string): HTMLElement {
  return h(
    'div',
    { class: 'status status--loading', role: 'status', 'aria-live': 'polite', 'aria-busy': 'true' },
    h('div', { class: 'spinner', 'aria-hidden': 'true' }),
    h('h2', { class: 'status-message' }, message),
    detail ? h('p', { class: 'status-detail' }, detail) : null,
  );
}

export function errorView(message: string, detail: string | undefined, actions: ErrorAction[], onAction: (a: ErrorAction) => void): HTMLElement {
  const buttons = actions.map((a, i) => {
    // The first action is the one the host recommends.
    const b = h('button', { type: 'button', class: i === 0 ? 'primary' : 'secondary', 'data-action': a }, ACTION_LABEL[a] ?? a);
    b.addEventListener('click', () => onAction(a));
    return b;
  });
  return h(
    'div',
    { class: 'status status--error', role: 'alert' },
    h('div', { class: 'status-icon', 'aria-hidden': 'true' }, '!'),
    h('h2', { class: 'status-message' }, message),
    detail ? h('details', { class: 'status-details' }, h('summary', {}, 'Details'), h('pre', {}, detail)) : null,
    buttons.length ? h('div', { class: 'status-actions' }, ...buttons) : null,
  );
}

export function waitingView(): HTMLElement {
  return h('div', { class: 'status status--waiting', role: 'status' }, h('div', { class: 'spinner', 'aria-hidden': 'true' }), h('h2', { class: 'status-message' }, 'Waiting for the review…'));
}

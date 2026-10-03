// Helpers for the review pane in e2e tests: the question set as the test reads it (from disk,
// independently of the extension), the host's review snapshot, and the pane's tabs, cards and
// text boxes as the webview draws them.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as vscode from 'vscode';
import type { Depth, Question, QuestionSet } from '../../src/contract/questions';
import { includesDepth } from '../../src/review/order';
import type { ReviewSnapshot } from '../../src/review/types';
import type { Workbench } from './cdp';
import { extensionPath, filos, sleep, waitFor } from './helpers';

let questionsCache: QuestionSet | undefined;

export function sampleQuestions(): QuestionSet {
  questionsCache ??= JSON.parse(readFileSync(join(extensionPath(), 'fixtures', 'sample-questions.json'), 'utf8')) as QuestionSet;
  return questionsCache;
}

export function sampleQuestion(id: string): Question {
  const q = sampleQuestions().questions.find((x) => x.id === id);
  if (!q) throw new Error(`fixtures/sample-questions.json has no question "${id}"`);
  return q;
}

/** Ids of the sample's questions a review at `depth` asks. */
export function idsAt(depth: Depth): string[] {
  return sampleQuestions()
    .questions.filter((q) => includesDepth(depth, q.depth))
    .map((q) => q.id);
}

/** The latest review snapshot that satisfies `pred` (waits for it). */
export async function snapshotWhere(pred: (s: ReviewSnapshot) => boolean, what: string, timeoutMs = 10_000): Promise<ReviewSnapshot> {
  const api = await filos();
  return waitFor(() => {
    const s = api.getReviewSnapshot();
    return s && pred(s) ? s : undefined;
  }, what, timeoutMs);
}

export const snapshot = () => snapshotWhere(() => true, 'a review snapshot');

export const qSel = (id: string) => `[data-question-id=${JSON.stringify(id)}]`;
export const cSel = (id: string) => `[data-comment-id=${JSON.stringify(id)}]`;
export const keySel = (key: string) => `[data-focus-key=${JSON.stringify(key)}]`;
export const draftSel = (key: string) => `[data-draft=${JSON.stringify(key)}]`;

export type Tab = 'summary' | 'questions' | 'comments';

/** Clicks a tab of the side pane and waits until its panel is the one shown. */
export async function openTab(wb: Workbench, tab: Tab): Promise<void> {
  await wb.clickWebview(`.pane-tabs [data-tab="${tab}"]`);
  await wb.waitForWebview<boolean>(
    `(d, w, f, tab) => d.querySelector('[data-tab="' + tab + '"]')?.getAttribute('aria-selected') === 'true' && d.getElementById('filos-panel-' + tab)?.hidden === false`,
    `the ${tab} tab`,
    5_000,
    tab,
  );
}

/** What a question card shows: its state, the feedback box (class and text) and its buttons. */
export interface CardView {
  state: string;
  verdict?: string;
  feedback: string;
  buttons: string[];
}

const READ_CARD = `(d, w, f, sel) => {
  const card = d.querySelector(sel);
  if (!card) return null;
  const fb = card.querySelector('.feedback');
  return {
    state: card.dataset.state,
    verdict: fb ? [...fb.classList].find((c) => c.startsWith('verdict--'))?.slice('verdict--'.length) : undefined,
    feedback: fb ? fb.textContent.replace(/\\s+/g, ' ').trim() : '',
    buttons: [...card.querySelectorAll('button')].map((b) => b.textContent.replace(/\\s+/g, ' ').trim()),
  };
}`;

/** Waits until the card of question `id` is drawn in `state`, and returns what it shows. */
export function cardIn(wb: Workbench, id: string, state: string, scope = '', timeoutMs = 10_000): Promise<CardView> {
  return wb.waitForWebview<CardView>(
    `(d, w, f, sel, state) => { const v = (${READ_CARD})(d, w, f, sel); return v && v.state === state ? v : null; }`,
    `question ${id} drawn as ${state}`,
    timeoutMs,
    `${scope} ${qSel(id)}`.trim(),
    state,
  );
}

/** Ids of the question cards in a panel, in the order drawn. */
export function cardIds(wb: Workbench, panel = '#filos-panel-questions'): Promise<string[]> {
  return wb.evalWebview<string[]>(`(d, w, f, panel) => [...d.querySelectorAll(panel + ' [data-question-id]')].map((e) => e.dataset.questionId)`, panel);
}

/** Text content of the first element matching `selector`, whitespace collapsed ('' when absent). */
export function textOf(wb: Workbench, selector: string): Promise<string> {
  return wb.evalWebview<string>(`(d, w, f, sel) => (d.querySelector(sel)?.textContent ?? '').replace(/\\s+/g, ' ').trim()`, selector);
}

/** Whether the first element matching `selector` is marked aria-disabled. */
export function isDisabled(wb: Workbench, selector: string): Promise<boolean> {
  return wb.evalWebview<boolean>(`(d, w, f, sel) => d.querySelector(sel)?.getAttribute('aria-disabled') === 'true'`, selector);
}

/**
 * Types into a text box the way a person does: click it, (select what's there, for `replace`),
 * then type. Returns the box's value afterwards.
 */
export async function typeInto(wb: Workbench, selector: string, text: string, opts: { replace?: boolean } = {}): Promise<string> {
  await wb.clickWebview(selector);
  await wb.waitForWebview<boolean>(`(d, w, f, sel) => d.activeElement === d.querySelector(sel)`, `${selector} to have focus`, 3_000, selector);
  // The select-all a person would do with Ctrl+A (VS Code may claim that key for itself).
  if (opts.replace) await wb.evalWebview(`(d, w, f, sel) => { d.querySelector(sel).select(); return true; }`, selector);
  await wb.type(text);
  return wb.evalWebview<string>(`(d, w, f, sel) => d.querySelector(sel)?.value ?? ''`, selector);
}

/**
 * Closes every editor, the review panel included. Unsaved untitled documents (an Export) are
 * reverted first: closing them would ask to save in a modal, which blocks the test run.
 */
export async function closeAllEditors(): Promise<void> {
  for (const doc of vscode.workspace.textDocuments.filter((d) => d.isUntitled && d.isDirty)) {
    await vscode.window.showTextDocument(doc);
    await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
  }
  await vscode.commands.executeCommand('workbench.action.closeAllEditors');
}

/** Notification toasts sit over the bottom right of the webview, where the pane's buttons are. */
export async function clearNotifications(): Promise<void> {
  await vscode.commands.executeCommand('notifications.clearAll');
  await sleep(250); // they animate out
}

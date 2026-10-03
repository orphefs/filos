// What must survive a re-render of the review pane: half-typed text, keyboard focus (with the caret)
// and scroll positions. The pane is rebuilt from every snapshot, which can arrive while the reviewer
// is typing (an agent reply landing), so nothing they wrote or where they were may be lost.
//
// Interactive elements carry data-focus-key, stable across renders; text areas carry data-draft.

import type { ReviewSnapshot } from '../review/types';
import { h } from './dom';

export class Drafts {
  private readonly values = new Map<string, string>();
  /** Drafts to drop once a snapshot shows their text arrived (the action wasn't ignored). */
  private readonly clearWhen = new Map<string, (review: ReviewSnapshot) => boolean>();

  get(key: string): string {
    return this.values.get(key) ?? '';
  }

  set(key: string, value: string): void {
    if (value) this.values.set(key, value);
    else this.values.delete(key);
  }

  clear(key: string): void {
    this.values.delete(key);
    this.clearWhen.delete(key);
  }

  /**
   * Keeps the draft until `arrived()` is true on a later snapshot, so an action the host ignored
   * (or that failed) doesn't eat what the reviewer wrote.
   */
  clearOnceArrived(key: string, arrived: (review: ReviewSnapshot) => boolean): void {
    this.clearWhen.set(key, arrived);
  }

  /** Call with every new snapshot, before rendering. */
  settle(review: ReviewSnapshot): void {
    for (const [key, arrived] of this.clearWhen) {
      let done = false;
      try {
        done = arrived(review);
      } catch {
        done = true;
      }
      if (done) this.clear(key);
    }
  }

  /** A text area bound to the draft under `key`. */
  textarea(key: string, attrs: Record<string, string | number | boolean | undefined>, onInput?: (value: string) => void): HTMLTextAreaElement {
    const ta = h('textarea', { ...attrs, 'data-draft': key, 'data-focus-key': key, spellcheck: 'true' });
    ta.value = this.get(key);
    ta.addEventListener('input', () => {
      this.set(key, ta.value);
      onInput?.(ta.value);
      autosize(ta);
    });
    // Sized to the text once it is in the document (a comment body can be long).
    requestAnimationFrame(() => autosize(ta));
    return ta;
  }
}

/** Grows a text area with its text, up to about 18 lines; it scrolls after that. */
export function autosize(ta: HTMLTextAreaElement): void {
  if (!ta.isConnected) return;
  ta.style.height = 'auto';
  ta.style.height = `${Math.min(ta.scrollHeight + 2, 360)}px`;
}

export interface FocusMemo {
  key?: string;
  selStart?: number | null;
  selEnd?: number | null;
  scroll: Map<string, number>;
}

/** Notes what has focus inside `root` and how far each scroller (data-scroll-key) is scrolled. */
export function captureFocus(root: HTMLElement): FocusMemo {
  const memo: FocusMemo = { scroll: new Map() };
  const active = document.activeElement as HTMLElement | null;
  if (active && root.contains(active)) {
    memo.key = active.dataset.focusKey;
    if (active instanceof HTMLTextAreaElement || active instanceof HTMLInputElement) {
      memo.selStart = active.selectionStart;
      memo.selEnd = active.selectionEnd;
    }
  }
  for (const el of root.querySelectorAll<HTMLElement>('[data-scroll-key]')) memo.scroll.set(el.dataset.scrollKey!, el.scrollTop);
  return memo;
}

/**
 * Puts focus back on the element with the same key (or `prefer`, when an action asked for focus to
 * move, e.g. from Accept to its Undo), with the caret where it was, and restores scroll positions.
 */
export function restoreFocus(root: HTMLElement, memo: FocusMemo, prefer?: string): void {
  for (const el of root.querySelectorAll<HTMLElement>('[data-scroll-key]')) {
    const top = memo.scroll.get(el.dataset.scrollKey!);
    if (top !== undefined) el.scrollTop = top;
  }
  const find = (key: string | undefined) => (key ? root.querySelector<HTMLElement>(`[data-focus-key="${CSS.escape(key)}"]`) : null);
  const target = find(prefer) ?? find(memo.key);
  if (!target) return;
  if (target === document.activeElement) return;
  target.focus({ preventScroll: true });
  if (target.dataset.focusKey === memo.key && (target instanceof HTMLTextAreaElement || target instanceof HTMLInputElement) && memo.selStart != null) {
    try {
      target.setSelectionRange(memo.selStart, memo.selEnd ?? memo.selStart);
    } catch {
      /* not a text input */
    }
  }
}

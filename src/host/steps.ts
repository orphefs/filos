// The checklist a long review start shows while it works (find the pull request, get its code, the
// comprehension pass, questions). The host owns it and sends a copy with every 'loading' and
// 'error' message; the webview only draws it. Details can carry text that came from GitHub or the
// agent, so they are flattened and bounded here (the webview checks again). No vscode import.

import { safeProgressText } from '../agent/progress';
import type { LoadingStep } from '../protocol';

const MAX_DETAIL = 120;

export class LoadingSteps {
  private readonly steps: LoadingStep[];

  constructor(labels: readonly string[]) {
    this.steps = labels.map((label) => ({ label, state: 'pending' }));
  }

  /** The step now running, if any. */
  get active(): number | undefined {
    const i = this.steps.findIndex((s) => s.state === 'active');
    return i >= 0 ? i : undefined;
  }

  /** Step `i` is running: every step before it is done (a step can't start before its predecessors). */
  start(i: number, detail?: string): void {
    this.steps.forEach((s, k) => {
      if (k < i && s.state !== 'failed') s.state = 'done';
    });
    this.set(i, 'active', detail);
  }

  /** New detail for step `i` (e.g. the agent's live progress); undefined clears it. */
  detail(i: number, detail?: string): void {
    const s = this.steps[i];
    if (!s) return;
    const text = detail === undefined ? '' : safeProgressText(detail, MAX_DETAIL);
    if (text) s.detail = text;
    else delete s.detail;
  }

  done(i: number, detail?: string): void {
    this.set(i, 'done', detail);
  }

  /** Marks step `i` failed (by default the running one, else the first not done). Returns its index. */
  fail(i?: number, detail?: string): number {
    const at = i ?? this.active ?? Math.max(0, this.steps.findIndex((s) => s.state !== 'done'));
    this.set(at, 'failed', detail);
    // Nothing after a failure is running any more.
    this.steps.forEach((s, k) => {
      if (k !== at && s.state === 'active') s.state = 'pending';
    });
    return at;
  }

  /** A copy for a message: later changes don't reach a message already sent. */
  snapshot(): LoadingStep[] {
    return this.steps.map((s) => ({ ...s }));
  }

  private set(i: number, state: LoadingStep['state'], detail?: string): void {
    const s = this.steps[i];
    if (!s) return;
    s.state = state;
    if (detail !== undefined) this.detail(i, detail);
  }
}

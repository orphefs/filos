// Socrates, the guide of didactic mode: a small line drawing that stands beside the territory being
// entered (or the last one explored) with a one-line speech bubble. He walks to a new place with a
// short transition and otherwise stands still: no idle animation. Drawn over the graph in screen
// space, so the bubble stays readable at any zoom; the app re-places him when the view moves.

import { h, s } from './dom';
import type { Box } from './layout';

const FIG_W = 34;
const FIG_H = 50;

function figure(): SVGSVGElement {
  return s(
    'svg',
    { class: 'socrates-figure', width: FIG_W, height: FIG_H, viewBox: '0 0 34 50', 'aria-hidden': 'true', focusable: 'false' },
    // Toga, with the drape over one shoulder.
    s('path', { class: 'toga', d: 'M8 48 L10 27 Q17 23 24 27 L26 48 Z' }),
    s('path', { class: 'line', d: 'M11 28 L24 42' }),
    s('path', { class: 'line', d: 'M8 48 H26' }),
    // The questioning hand, finger raised.
    s('path', { class: 'line', d: 'M24 30 Q28.5 28.5 29.5 23' }),
    s('path', { class: 'line', d: 'M29.5 23 L29.8 19.5' }),
    // Head, beard and laurel.
    s('circle', { class: 'skin', cx: 17, cy: 12, r: 6.5 }),
    s('path', { class: 'beard', d: 'M11 13.5 Q11 22.5 17 24 Q23 22.5 23 13.5 Q20 16.5 17 16 Q14 16.5 11 13.5 Z' }),
    s('circle', { class: 'eye', cx: 14.8, cy: 11.2, r: 0.75 }),
    s('circle', { class: 'eye', cx: 19.2, cy: 11.2, r: 0.75 }),
    s('path', { class: 'laurel', d: 'M10.6 10 Q11.5 5 17 4.6 Q22.5 5 23.4 10' }),
    s('path', { class: 'leaf', d: 'M11.6 7.6 l-2.4 -0.6 M13.4 5.6 l-1.6 -1.8 M16 4.6 l-0.6 -2.2 M18 4.6 l0.6 -2.2 M20.6 5.6 l1.6 -1.8 M22.4 7.6 l2.4 -0.6' }),
  );
}

export class Socrates {
  readonly el: HTMLElement;
  private readonly bubble: HTMLElement;
  private target?: string;
  private shown = false;

  constructor() {
    this.bubble = h('p', { class: 'socrates-bubble' });
    this.el = h('div', { class: 'socrates', hidden: true, 'aria-hidden': 'true', 'data-testid': 'socrates' }, figure(), this.bubble);
  }

  /** The node he stands by (for tests and the next move). */
  get at(): string | undefined {
    return this.shown ? this.target : undefined;
  }

  hide(): void {
    this.shown = false;
    this.el.hidden = true;
  }

  /**
   * Stands beside `box` (screen coordinates inside the graph host of size `host`). He walks there
   * when the target changed; otherwise (a pan or zoom) he just keeps up.
   */
  place(targetId: string, box: Box, host: { width: number; height: number }, message: string): void {
    const walk = this.shown && targetId !== this.target;
    this.target = targetId;
    if (this.bubble.textContent !== message) this.bubble.textContent = message;
    this.el.dataset.at = targetId;
    const wasHidden = this.el.hidden;
    this.el.hidden = false;
    this.shown = true;

    // Feet level with the node's bottom edge, just left of it; on the right when there's no room.
    let x = box.x - FIG_W - 6;
    let side: 'left' | 'right' = 'left';
    if (x < 4) {
      x = box.x + box.width + 6;
      side = 'right';
    }
    let y = box.y + Math.min(box.height, 60) - FIG_H;
    x = Math.max(4, Math.min(host.width - FIG_W - 4, x));
    y = Math.max(34, Math.min(host.height - FIG_H - 4, y));
    this.el.dataset.side = side;
    // The bubble sits above his head and leans into the graph; clamp it inside the host.
    const bubbleW = Math.min(340, Math.max(120, host.width - 24));
    this.bubble.style.maxWidth = `${bubbleW}px`;
    const leftRoom = x + FIG_W / 2;
    const bubbleLeft = Math.max(-leftRoom + 8, Math.min(0, host.width - 8 - (x + bubbleW)));
    this.bubble.style.left = `${bubbleLeft}px`;

    this.el.classList.toggle('walking', walk && !wasHidden && !reducedMotion());
    this.el.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
    if (walk) {
      clearTimeout(this.walkTimer);
      this.walkTimer = setTimeout(() => this.el.classList.remove('walking'), 700);
    }
  }

  private walkTimer?: ReturnType<typeof setTimeout>;
}

function reducedMotion(): boolean {
  return matchMedia('(prefers-reduced-motion: reduce)').matches;
}

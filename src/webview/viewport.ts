// Pan and zoom for the graph SVG: drag anywhere to pan, wheel to zoom around the pointer.
// A drag never counts as a click, so panning across a node doesn't select it.

import type { Box, Point } from './layout';

const MIN_SCALE = 0.2;
const MAX_SCALE = 2.5;
const DRAG_THRESHOLD = 4;

export class Viewport {
  k = 1;
  tx = 0;
  ty = 0;
  /** The user has panned or zoomed since the last fit; resizes then keep their view. */
  userMoved = false;
  private suppressClick = false;

  constructor(
    private readonly svg: SVGSVGElement,
    private readonly world: SVGGElement,
    private readonly hooks: { onChange: () => void; onBackgroundClick: () => void },
  ) {
    svg.addEventListener('wheel', (ev) => this.onWheel(ev), { passive: false });
    svg.addEventListener('pointerdown', (ev) => this.onPointerDown(ev));
    // Capture phase: swallow the click that ends a drag before nodes see it.
    svg.addEventListener(
      'click',
      (ev) => {
        if (this.suppressClick) {
          this.suppressClick = false;
          ev.stopPropagation();
          ev.preventDefault();
          return;
        }
        if (!(ev.target as Element).closest('[data-node-id]')) this.hooks.onBackgroundClick();
      },
      true,
    );
  }

  size(): { width: number; height: number } {
    const r = this.svg.getBoundingClientRect();
    return { width: Math.max(1, r.width), height: Math.max(1, r.height) };
  }

  toScreen(p: Point): Point {
    return { x: p.x * this.k + this.tx, y: p.y * this.k + this.ty };
  }

  set(k: number, tx: number, ty: number, animate = false): void {
    this.k = Math.min(MAX_SCALE, Math.max(MIN_SCALE, k));
    this.tx = tx;
    this.ty = ty;
    this.world.classList.toggle('animate', animate);
    this.world.style.transform = `translate(${this.tx}px, ${this.ty}px) scale(${this.k})`;
    this.hooks.onChange();
  }

  /** The scale at which the box would fit the view. */
  fitScale(bounds: Box, maxScale = 1.1): number {
    const { width, height } = this.size();
    const pad = 24;
    return Math.min(maxScale, (width - 2 * pad) / Math.max(1, bounds.width), (height - 2 * pad) / Math.max(1, bounds.height));
  }

  /**
   * Scale and centre so the whole box is visible. Never magnifies beyond 110%. With a minScale
   * (automatic fits) it stops at a readable size and centres instead; the user can pan the rest.
   */
  fit(bounds: Box, animate = false, minScale = MIN_SCALE): void {
    const { width, height } = this.size();
    const k = Math.min(MAX_SCALE, Math.max(minScale, MIN_SCALE, this.fitScale(bounds)));
    let ty = (height - bounds.height * k) / 2 - bounds.y * k;
    // Too tall to fit: start at the top rather than in the middle.
    if (bounds.height * k > height) ty = 16 - bounds.y * k;
    this.set(k, (width - bounds.width * k) / 2 - bounds.x * k, ty, animate);
    this.userMoved = false;
  }

  zoomBy(factor: number, around?: Point): void {
    const { width, height } = this.size();
    const c = around ?? { x: width / 2, y: height / 2 };
    const k = Math.min(MAX_SCALE, Math.max(MIN_SCALE, this.k * factor));
    const f = k / this.k;
    this.set(k, c.x - (c.x - this.tx) * f, c.y - (c.y - this.ty) * f, !around);
    this.userMoved = true;
  }

  /** Keeps a world point at the given screen position (used to hold a clicked node still across a re-layout). */
  pin(world: Point, screen: Point, animate = false): void {
    this.set(this.k, screen.x - world.x * this.k, screen.y - world.y * this.k, animate);
  }

  /** Pans (and, if the box is too big, zooms out) the least amount needed to show the box. */
  ensureVisible(box: Box, animate = false): void {
    const { width, height } = this.size();
    const m = 20;
    const need = Math.min((width - 2 * m) / box.width, (height - 2 * m) / box.height);
    const k = need < this.k ? Math.max(MIN_SCALE, need) : this.k;
    // Zooming out (if needed) happens around the view centre, then we pan.
    const f = k / this.k;
    let tx = width / 2 - (width / 2 - this.tx) * f;
    let ty = height / 2 - (height / 2 - this.ty) * f;
    const left = box.x * k + tx;
    const top = box.y * k + ty;
    const right = left + box.width * k;
    const bottom = top + box.height * k;
    if (left < m) tx += m - left;
    else if (right > width - m) tx -= right - (width - m);
    if (top < m) ty += m - top;
    else if (bottom > height - m) ty -= bottom - (height - m);
    if (k !== this.k || tx !== this.tx || ty !== this.ty) this.set(k, tx, ty, animate);
  }

  private onWheel(ev: WheelEvent): void {
    // When the panel is stacked and scrolls, a plain wheel scrolls the page; zooming then needs
    // Ctrl/Cmd (trackpad pinch arrives as ctrl+wheel, so pinch still zooms).
    const page = document.scrollingElement;
    if (!ev.ctrlKey && !ev.metaKey && page && page.scrollHeight > page.clientHeight + 1) return;
    ev.preventDefault();
    const r = this.svg.getBoundingClientRect();
    // Pixel deltas from trackpads are small and frequent; line/page deltas come from wheels.
    const delta = ev.deltaMode === 1 ? ev.deltaY * 16 : ev.deltaMode === 2 ? ev.deltaY * 400 : ev.deltaY;
    this.zoomBy(Math.exp(-delta * 0.0015), { x: ev.clientX - r.left, y: ev.clientY - r.top });
  }

  private onPointerDown(ev: PointerEvent): void {
    if (ev.button !== 0) return;
    const start = { x: ev.clientX, y: ev.clientY, tx: this.tx, ty: this.ty };
    let dragging = false;
    const move = (e: PointerEvent) => {
      const dx = e.clientX - start.x;
      const dy = e.clientY - start.y;
      if (!dragging && Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
      if (!dragging) {
        dragging = true;
        this.svg.classList.add('panning');
      }
      this.set(this.k, start.tx + dx, start.ty + dy);
      this.userMoved = true;
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      this.svg.classList.remove('panning');
      if (dragging) {
        this.suppressClick = true;
        // If no click follows (pointer released outside the svg), don't swallow a later one.
        setTimeout(() => (this.suppressClick = false), 0);
      }
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
  }
}

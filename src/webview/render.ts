// SVG drawing of the laid-out graph. Three layers, bottom to top: container backgrounds, edges,
// then interactive nodes in tree order (so Tab follows module → its children → next module).
// Edges sit above container fills, so nothing is hidden behind an expanded module.

import type { GraphNode } from '../contract/graph';
import type { RiskScore } from '../contract/risk';
import { s } from './dom';
import type { Box, Layout, Point } from './layout';
import { CHANGE_WORD, childrenOf, describeNode, isContainer, type Model, type VisibleEdge } from './model';
import { fit, measure, type Fonts } from './text';

export interface RenderContext {
  model: Model;
  expanded: ReadonlySet<string>;
  selected?: string;
  visited: ReadonlySet<string>;
  fonts: Fonts;
}

export interface GraphHandlers {
  /** Click, Enter or Space on a node. */
  activate(id: string): void;
  /** Click on a module's chevron. */
  toggle(id: string): void;
  keydown(id: string, ev: KeyboardEvent): void;
  /** Pointer or keyboard focus entered (id) or left (undefined) a node. */
  hover(id: string | undefined): void;
}

const PAD_X = 12;
const LEAF_H = 52;
const MODULE_H = 56;
export const HEADER_H = 40;
const MAX_TITLE = 240;
const MIN_W = 150;
const CODE_KINDS = new Set(['function', 'class', 'type']);

type Shape = 'leaf' | 'module' | 'container' | 'external';

/** Everything a node shows, computed once and used for both sizing and drawing. */
interface Face {
  shape: Shape;
  title: string;
  titleFull: string;
  truncated: boolean;
  titleFont: string;
  badge?: string;
  count?: number;
  risk?: RiskScore;
  riskText?: string;
  extText?: string;
  sub?: string;
  visited: boolean;
  /** Widths of the pieces, for placement. */
  w: { title: number; badge: number; count: number; risk: number; ext: number; sub: number };
}

function faceFor(node: GraphNode, ctx: RenderContext): Face {
  const { model, fonts } = ctx;
  const kids = childrenOf(model, node.id).length;
  const shape: Shape =
    node.kind === 'external' ? 'external' : kids > 0 ? (ctx.expanded.has(node.id) ? 'container' : 'module') : 'leaf';
  const titleFont = CODE_KINDS.has(node.kind) ? fonts.code : fonts.label;
  const t = fit(node.label, titleFont, MAX_TITLE);
  const risk = node.kind === 'external' ? undefined : model.risk.get(node.id);
  const ext = model.externalsOf.get(node.id)?.size ?? 0;
  const uses = node.kind === 'external' ? model.graph.edges.filter((e) => e.from === node.id).length : 0;
  const face: Face = {
    shape,
    title: t.text,
    titleFull: node.label,
    truncated: t.truncated,
    titleFont,
    badge: node.kind === 'external' ? undefined : CHANGE_WORD[node.change].toUpperCase(),
    count: kids > 0 ? kids : undefined,
    risk,
    riskText: risk ? `${risk.band} risk` : undefined,
    extText: ext ? `↗ ${ext} outside` : undefined,
    sub: node.kind === 'external' ? `outside this repo${uses ? ` · uses ${uses}` : ''}` : undefined,
    visited: ctx.visited.has(node.id),
    w: { title: 0, badge: 0, count: 0, risk: 0, ext: 0, sub: 0 },
  };
  face.w.title = measure(face.title, titleFont);
  face.w.badge = face.badge ? measure(face.badge, fonts.badge) + 10 : 0;
  face.w.count = face.count ? Math.max(18, measure(String(face.count), fonts.badge) + 10) : 0;
  face.w.risk = face.riskText ? measure(face.riskText, fonts.small) : 0;
  face.w.ext = face.extText ? measure(face.extText, fonts.small) : 0;
  face.w.sub = face.sub ? measure(face.sub, fonts.small) : 0;
  return face;
}

const CHEVRON_W = 16;
const METER_W = 14;
const VISITED_W = 14;

function riskRowWidth(f: Face): number {
  return METER_W + 5 + f.w.risk + (f.extText ? 10 + f.w.ext : 0) + (f.visited ? 8 + VISITED_W : 0);
}

/** Size a node needs (containers: the minimum, ELK grows them around their children). */
export function nodeSize(node: GraphNode, ctx: RenderContext): { width: number; height: number } {
  const f = faceFor(node, ctx);
  const chev = f.shape === 'module' || f.shape === 'container' ? CHEVRON_W : 0;
  const titleRow = chev + f.w.title + (f.count ? 6 + f.w.count : 0);
  switch (f.shape) {
    case 'external':
      return { width: Math.max(MIN_W, PAD_X * 2 + Math.max(18 + f.w.title, f.w.sub)), height: LEAF_H };
    case 'container':
      return { width: PAD_X * 2 + titleRow + 16 + riskRowWidth(f) + 12 + f.w.badge, height: HEADER_H + 24 };
    default: {
      const row1 = titleRow + 12 + f.w.badge;
      return {
        width: Math.ceil(Math.max(MIN_W, PAD_X * 2 + Math.max(row1, riskRowWidth(f)))),
        height: f.shape === 'module' ? MODULE_H : LEAF_H,
      };
    }
  }
}

/** Fill strength for the risk tint: redder means scarier. */
// Convex, so low risk stays close to neutral and only real risk turns red. Capped at 44%: node
// text (editor ink) on the reddest fill then keeps ≥ 4.9:1 in Light Modern, Light+, Dark and HC.
export function tint(level: number): { fill: string; soft: string; stroke: string } {
  const l = Math.max(0, Math.min(1, level));
  const fill = 2 + 42 * l ** 1.5;
  return { fill: `${Math.round(fill)}%`, soft: `${Math.round(fill * 0.3)}%`, stroke: `${Math.round(10 + 90 * l ** 1.2)}%` };
}

export function setTint(el: SVGElement | HTMLElement, level: number | undefined): void {
  if (level === undefined) return;
  const t = tint(level);
  el.style.setProperty('--tint', t.fill);
  el.style.setProperty('--tint-soft', t.soft);
  el.style.setProperty('--tint-stroke', t.stroke);
}

function badge(f: Face, x: number, y: number): SVGGElement | null {
  if (!f.badge) return null;
  return s(
    'g',
    { class: 'badge', transform: `translate(${x},${y})` },
    s('rect', { width: f.w.badge, height: 15, rx: 3 }),
    s('text', { x: f.w.badge / 2, y: 11, 'text-anchor': 'middle' }, f.badge),
  );
}

function countPill(f: Face, x: number, y: number): SVGGElement | null {
  if (!f.count) return null;
  return s(
    'g',
    { class: 'count', transform: `translate(${x},${y})` },
    s('rect', { width: f.w.count, height: 16, rx: 8 }),
    s('text', { x: f.w.count / 2, y: 12, 'text-anchor': 'middle' }, String(f.count)),
  );
}

/** Three bars, filled up to the risk band: a shape cue that doesn't rely on colour. */
function meter(risk: RiskScore, x: number, y: number): SVGGElement {
  const filled = risk.band === 'high' ? 3 : risk.band === 'medium' ? 2 : 1;
  const g = s('g', { class: `meter band-${risk.band}`, transform: `translate(${x},${y})`, 'aria-hidden': 'true' });
  for (let i = 0; i < 3; i++) {
    g.append(s('rect', { x: i * 5, y: 6 - i * 3, width: 3.5, height: 4 + i * 3, rx: 1, class: i < filled ? 'on' : 'off' }));
  }
  return g;
}

function riskRow(f: Face, x: number, baseline: number): SVGElement[] {
  const out: SVGElement[] = [];
  if (!f.risk) return out;
  out.push(meter(f.risk, x, baseline - 10));
  let cx = x + METER_W + 5;
  out.push(s('text', { class: `meta risk-text band-${f.risk.band}`, x: cx, y: baseline }, f.riskText));
  cx += f.w.risk;
  if (f.extText) {
    cx += 10;
    // The arrow glyph carries the "outside" colour; the words stay in the high-contrast ink.
    out.push(s('text', { class: 'meta ext-text', x: cx, y: baseline }, s('tspan', { class: 'ext-glyph' }, '↗'), f.extText!.slice(1)));
    cx += f.w.ext;
  }
  if (f.visited) out.push(visitedMark(cx + 8, baseline - 9));
  return out;
}

function visitedMark(x: number, y: number): SVGGElement {
  return s(
    'g',
    { class: 'visited-mark', transform: `translate(${x},${y})` },
    s('title', {}, 'You have looked at this'),
    s('circle', { cx: 6, cy: 5, r: 6 }),
    s('path', { d: 'M3 5.2 L5.2 7.4 L9 3.2' }),
  );
}

function chevron(expanded: boolean, x: number, y: number, label: string): SVGGElement {
  return s(
    'g',
    { class: 'chevron', transform: `translate(${x},${y})`, 'data-chevron': 'true' },
    s('title', {}, `${expanded ? 'Collapse' : 'Expand'} ${label}`),
    s('rect', { x: -4, y: -4, width: 20, height: 20, class: 'chevron-hit' }),
    s('path', { d: expanded ? 'M2 4 L6 8.5 L10 4' : 'M4 2 L8.5 6 L4 10' }),
  );
}

export class GraphView {
  readonly svg: SVGSVGElement;
  readonly world: SVGGElement;
  private readonly bgLayer: SVGGElement;
  private readonly edgeLayer: SVGGElement;
  private readonly nodeLayer: SVGGElement;
  private readonly nodeEls = new Map<string, SVGGElement>();
  /** Edge labels, placed on demand by highlight(). */
  private labels: { g: SVGGElement; from: string; to: string; pts: Point[]; w: number; h: number }[] = [];
  /** Boxes labels must not cover: every drawn node, and the header strip of containers. */
  private obstacles: Box[] = [];
  /** Absolute boxes of the last render. */
  boxes = new Map<string, Box>();
  private containers = new Set<string>();
  bounds: Box = { x: 0, y: 0, width: 0, height: 0 };

  constructor(private readonly handlers: GraphHandlers) {
    this.bgLayer = s('g', { class: 'layer-containers', 'aria-hidden': 'true' });
    this.edgeLayer = s('g', { class: 'layer-edges', 'aria-hidden': 'true' });
    this.nodeLayer = s('g', { class: 'layer-nodes' });
    this.world = s('g', { class: 'world' }, this.bgLayer, this.edgeLayer, this.nodeLayer);
    this.svg = s('svg', { class: 'graph-svg', role: 'group', 'aria-label': 'Review graph', 'aria-roledescription': 'graph' }, this.world);

    this.nodeLayer.addEventListener('click', (ev) => {
      const el = (ev.target as Element).closest<SVGGElement>('[data-node-id]');
      if (!el) return;
      const id = el.dataset.nodeId!;
      if ((ev.target as Element).closest('[data-chevron]')) this.handlers.toggle(id);
      else this.handlers.activate(id);
    });
    this.nodeLayer.addEventListener('keydown', (ev) => {
      const el = (ev.target as Element).closest<SVGGElement>('[data-node-id]');
      if (el) this.handlers.keydown(el.dataset.nodeId!, ev);
    });
    const hover = (ev: Event, leaving: boolean) => {
      const el = (ev.target as Element).closest<SVGGElement>('[data-node-id]');
      this.handlers.hover(leaving || !el ? undefined : el.dataset.nodeId);
    };
    this.nodeLayer.addEventListener('pointerover', (ev) => hover(ev, false));
    this.nodeLayer.addEventListener('pointerleave', (ev) => hover(ev, true));
  }

  /**
   * Keyboard focus highlights like hover. The listeners go on an HTML ancestor: Blink makes any
   * SVG element with focus listeners focusable, which would add a stray Tab stop.
   */
  trackFocus(host: HTMLElement): void {
    const node = (ev: Event) => (ev.target as Element).closest?.<SVGGElement>('[data-node-id]');
    host.addEventListener('focusin', (ev) => this.handlers.hover(node(ev)?.dataset.nodeId));
    host.addEventListener('focusout', () => this.handlers.hover(undefined));
  }

  nodeEl(id: string): SVGGElement | undefined {
    return this.nodeEls.get(id);
  }

  focusNode(id: string): boolean {
    const el = this.nodeEls.get(id);
    if (!el) return false;
    el.focus({ preventScroll: true });
    return true;
  }

  render(ctx: RenderContext, visible: GraphNode[], layout: Layout, edges: VisibleEdge[], animate: boolean): void {
    const prev = this.boxes;
    const hadFocus = (document.activeElement as Element | null)?.closest?.('[data-node-id]') as SVGGElement | null;
    const focusId = hadFocus && this.nodeLayer.contains(hadFocus) ? hadFocus.dataset.nodeId : undefined;

    this.bgLayer.replaceChildren();
    this.edgeLayer.replaceChildren();
    this.nodeLayer.replaceChildren();
    this.nodeEls.clear();
    this.labels = [];
    this.obstacles = visible.flatMap((n) => {
      const b = layout.nodes.get(n.id);
      if (!b) return [];
      // Containers only block their header strip; labels may sit in their body.
      return isContainer(ctx.model, n.id, ctx.expanded) ? [{ ...b, height: HEADER_H }] : [b];
    });
    this.boxes = layout.nodes;
    this.bounds = { x: 0, y: 0, width: layout.width, height: layout.height };

    const moves: { el: SVGGElement; from: Point; to: Point; fade: boolean }[] = [];
    const prevContainers = this.containers;
    this.containers = new Set(visible.filter((n) => isContainer(ctx.model, n.id, ctx.expanded)).map((n) => n.id));
    const place = (el: SVGGElement, id: string, box: Box, isContainerPart: boolean) => {
      el.style.transform = `translate(${box.x}px, ${box.y}px)`;
      if (!animate) return;
      // A module that just opened has a new size: fade it in where it ends up rather than slide it.
      if (isContainerPart && !prevContainers.has(id)) {
        moves.push({ el, from: box, to: box, fade: true });
        return;
      }
      // New nodes (children appearing on expand) start where their parent was.
      const parent = ctx.model.byId.get(id)?.parent;
      const from = prev.get(id) ?? (parent ? prev.get(parent) : undefined);
      if (from && (from.x !== box.x || from.y !== box.y || !prev.has(id))) moves.push({ el, from, to: box, fade: !prev.has(id) });
    };

    for (const node of visible) {
      const box = layout.nodes.get(node.id);
      if (!box) continue;
      const face = faceFor(node, ctx);
      if (face.shape === 'container') {
        const bg = this.drawContainerBg(face, box);
        place(bg, node.id, box, true);
        this.bgLayer.append(bg);
      }
      const el = this.drawNode(node, face, box, ctx);
      place(el, node.id, box, face.shape === 'container');
      this.nodeEls.set(node.id, el);
      this.nodeLayer.append(el);
    }

    for (const e of edges) {
      const route = layout.edges.get(e.id);
      if (route && route.points.length >= 2) this.edgeLayer.append(this.drawEdge(e, route.points, ctx, animate));
    }

    if (moves.length) {
      for (const m of moves) {
        m.el.classList.remove('moving');
        m.el.style.transform = `translate(${m.from.x}px, ${m.from.y}px)`;
        if (m.fade) m.el.style.opacity = '0';
      }
      void this.svg.getBoundingClientRect(); // commit the start positions before transitioning
      for (const m of moves) {
        m.el.classList.add('moving');
        m.el.style.transform = `translate(${m.to.x}px, ${m.to.y}px)`;
        m.el.style.opacity = '';
      }
    }

    if (focusId) this.focusNode(focusId) || this.focusNearest(ctx, focusId);
  }

  private focusNearest(ctx: RenderContext, id: string): void {
    for (let p = ctx.model.byId.get(id)?.parent; p; p = ctx.model.byId.get(p)?.parent) {
      if (this.focusNode(p)) return;
    }
  }

  /**
   * Emphasise edges touching these nodes and dim the rest (undefined clears). Labels are shown
   * for the edges of labelFor only, each where it overlaps no node and no other label.
   */
  highlight(ids: ReadonlySet<string> | undefined, labelFor: string | undefined): void {
    this.svg.classList.toggle('has-highlight', !!ids && ids.size > 0);
    for (const g of this.edgeLayer.children) {
      const el = g as SVGGElement;
      const on = !!ids && (ids.has(el.dataset.from!) || ids.has(el.dataset.to!));
      el.classList.toggle('is-hl', on);
    }
    const placed: Box[] = [];
    for (const l of this.labels) {
      const pos = labelFor && (l.from === labelFor || l.to === labelFor) ? placeLabel(l, this.obstacles, placed) : undefined;
      l.g.classList.toggle('is-shown', !!pos);
      if (!pos) continue;
      l.g.setAttribute('transform', `translate(${pos.x},${pos.y})`);
      placed.push(pos);
    }
  }

  private drawContainerBg(f: Face, box: Box): SVGGElement {
    const g = s(
      'g',
      { class: 'container-bg' },
      s('rect', { class: 'bg body', width: box.width, height: box.height, rx: 8 }),
      s('path', { class: 'bg header', d: roundedTop(box.width, HEADER_H, 8) }),
    );
    setTint(g, f.risk?.level);
    return g;
  }

  private drawNode(node: GraphNode, f: Face, box: Box, ctx: RenderContext): SVGGElement {
    const selected = ctx.selected === node.id;
    const isCont = f.shape === 'container';
    const cls = ['node', `node--${f.shape}`, `kind--${node.kind}`, `change--${node.change}`];
    if (selected) cls.push('is-selected');
    if (f.visited) cls.push('is-visited');
    if (f.risk) cls.push(`band-${f.risk.band}`);
    const g = s('g', {
      class: cls.join(' '),
      role: 'button',
      tabindex: 0,
      'data-node-id': node.id,
      'data-kind': node.kind,
      'aria-label': describeNode(ctx.model, node, { visited: f.visited }),
      'aria-pressed': selected ? 'true' : 'false',
      'aria-current': selected ? 'true' : undefined,
      'aria-expanded': f.count ? String(isCont) : undefined,
    });
    setTint(g, f.risk?.level);
    const tip = [f.titleFull, node.risk.why].filter(Boolean).join('\n');
    g.append(s('title', {}, tip));

    const w = box.width;
    const h = isCont ? box.height : box.height;
    g.append(s('rect', { class: 'ring', x: -4, y: -4, width: w + 8, height: h + 8, rx: isCont ? 11 : 9 }));

    if (isCont) {
      // Transparent hit area: clicking anywhere in the container selects the module.
      g.append(s('rect', { class: 'hit', width: w, height: h, rx: 8 }));
      const cy = HEADER_H / 2;
      let x = PAD_X;
      g.append(chevron(true, x, cy - 6, f.titleFull));
      x += CHEVRON_W;
      g.append(s('text', { class: 'title title--module', x, y: cy + 5 }, f.title));
      x += f.w.title + 6;
      const pill = countPill(f, x, cy - 8);
      if (pill) g.append(pill);
      x += f.w.count + 16;
      g.append(...riskRow(f, x, cy + 4));
      const b = badge(f, w - PAD_X - f.w.badge, cy - 7.5);
      if (b) g.append(b);
      return g;
    }

    if (f.shape === 'module') g.append(s('rect', { class: 'stack', x: 5, y: 5, width: w, height: h, rx: 6 }));
    g.append(s('rect', { class: 'bg', width: w, height: h, rx: 6 }));

    if (f.shape === 'external') {
      g.append(s('path', { class: 'ext-icon', d: 'M0 10 L10 0 M4 0 L10 0 L10 6', transform: `translate(${PAD_X},${12})` }));
      g.append(s('text', { class: 'title', x: PAD_X + 18, y: 22 }, f.title));
      g.append(s('text', { class: 'meta ext-sub', x: PAD_X, y: 41 }, f.sub));
      return g;
    }

    let x = PAD_X;
    if (f.shape === 'module') {
      g.append(chevron(false, x, 10, f.titleFull));
      x += CHEVRON_W;
    }
    g.append(s('text', { class: `title${f.shape === 'module' ? ' title--module' : ''}`, x, y: 21 }, f.title));
    if (f.count) {
      const pill = countPill(f, x + f.w.title + 6, 8);
      if (pill) g.append(pill);
    }
    const b = badge(f, w - PAD_X + 2 - f.w.badge, 8);
    if (b) g.append(b);
    g.append(...riskRow(f, PAD_X, f.shape === 'module' ? 43 : 40));
    return g;
  }

  private drawEdge(e: VisibleEdge, pts: Point[], ctx: RenderContext, animate: boolean): SVGGElement {
    const n = e.edges.length;
    const width = Math.min(4.5, 1.5 + (n - 1) * 0.9);
    const cls = ['edge', `edge--${e.kind}`];
    if (e.lifted) cls.push('edge--lifted');
    if (n > 1) cls.push('edge--merged');
    if (animate) cls.push('appear');
    const g = s('g', { class: cls.join(' '), 'data-from': e.from, 'data-to': e.to, 'data-edge-id': e.id });
    g.style.setProperty('--edge-w', `${width}px`);

    // Stop the line short of the target so it doesn't poke through the arrowhead.
    const arrowLen = 7 + width;
    const last = pts[pts.length - 1];
    const prev = pts[pts.length - 2];
    const len = Math.hypot(last.x - prev.x, last.y - prev.y) || 1;
    const ux = (last.x - prev.x) / len;
    const uy = (last.y - prev.y) / len;
    const trimmed = [...pts.slice(0, -1), { x: last.x - ux * (arrowLen - 1), y: last.y - uy * (arrowLen - 1) }];
    const d = roundedPath(trimmed, 6);

    const name = (id: string) => ctx.model.byId.get(id)?.label ?? id;
    const lines = e.edges.map((x) => `${name(x.from)} ${verb(x.kind)} ${name(x.to)}${x.label ? `: ${x.label}` : ''}`);
    g.append(s('title', {}, lines.join('\n')));
    g.append(s('path', { class: 'edge-hit', d }));
    g.append(s('path', { class: 'edge-line', d }));
    const half = (arrowLen * 0.62) / 1.2;
    const bx = last.x - ux * arrowLen;
    const by = last.y - uy * arrowLen;
    g.append(
      s('path', {
        class: 'edge-arrow',
        d: `M${last.x} ${last.y} L${bx - uy * half} ${by + ux * half} L${bx + uy * half} ${by - ux * half} Z`,
      }),
    );

    const mid = longestSegmentMidpoint(pts);
    if (n > 1) {
      // Merged edges show how many connections they stand for; the tooltip lists them.
      g.append(
        s(
          'g',
          { class: 'edge-count', transform: `translate(${mid.x},${mid.y})` },
          s('circle', { r: 9 }),
          s('text', { y: 3.5, 'text-anchor': 'middle' }, String(n)),
        ),
      );
    } else if (e.edges[0].label && !e.lifted) {
      // Shown only while an end is selected, hovered or focused: labels on every edge crowd the picture.
      const text = e.edges[0].label;
      const tw = measure(text, ctx.fonts.small) + 10;
      const lg = s('g', { class: 'edge-label' }, s('rect', { width: tw, height: 18, rx: 4 }), s('text', { x: tw / 2, y: 12.5, 'text-anchor': 'middle' }, text));
      g.append(lg);
      this.labels.push({ g: lg, from: e.from, to: e.to, pts, w: tw, h: 18 });
    }
    return g;
  }
}

export function verb(kind: VisibleEdge['kind']): string {
  switch (kind) {
    case 'calls':
      return 'calls';
    case 'imports':
      return 'imports';
    case 'consumes':
      return 'uses';
    case 'tests':
      return 'tests';
    case 'affects':
      return 'affects';
  }
}

const overlaps = (a: Box, b: Box, m = 2) => a.x < b.x + b.width + m && b.x < a.x + a.width + m && a.y < b.y + b.height + m && b.y < a.y + a.height + m;

/** First spot along the edge (longest segments first) where the label covers nothing. */
function placeLabel(l: { pts: Point[]; w: number; h: number }, obstacles: Box[], placed: Box[]): Box | undefined {
  const segs: { a: Point; b: Point; len: number }[] = [];
  for (let i = 1; i < l.pts.length; i++) {
    const a = l.pts[i - 1];
    const b = l.pts[i];
    segs.push({ a, b, len: Math.hypot(b.x - a.x, b.y - a.y) });
  }
  segs.sort((x, y) => y.len - x.len);
  for (const { a, b } of segs) {
    for (const t of [0.5, 0.3, 0.7, 0.15, 0.85]) {
      const box = { x: a.x + (b.x - a.x) * t - l.w / 2, y: a.y + (b.y - a.y) * t - l.h / 2, width: l.w, height: l.h };
      if (!obstacles.some((o) => overlaps(box, o)) && !placed.some((p) => overlaps(box, p))) return box;
    }
  }
  return undefined;
}

function longestSegmentMidpoint(pts: Point[]): Point {
  let best = 0;
  let mid = pts[0];
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1];
    const b = pts[i];
    const l = Math.hypot(b.x - a.x, b.y - a.y);
    if (l > best) {
      best = l;
      mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    }
  }
  return mid;
}

/** Orthogonal polyline with softened corners. */
function roundedPath(pts: Point[], r: number): string {
  let d = `M${pts[0].x} ${pts[0].y}`;
  for (let i = 1; i < pts.length - 1; i++) {
    const a = pts[i - 1];
    const b = pts[i];
    const c = pts[i + 1];
    const l1 = Math.hypot(b.x - a.x, b.y - a.y);
    const l2 = Math.hypot(c.x - b.x, c.y - b.y);
    const rr = Math.min(r, l1 / 2, l2 / 2);
    if (rr < 0.5) {
      d += ` L${b.x} ${b.y}`;
      continue;
    }
    const p1 = { x: b.x - ((b.x - a.x) / l1) * rr, y: b.y - ((b.y - a.y) / l1) * rr };
    const p2 = { x: b.x + ((c.x - b.x) / l2) * rr, y: b.y + ((c.y - b.y) / l2) * rr };
    d += ` L${p1.x} ${p1.y} Q${b.x} ${b.y} ${p2.x} ${p2.y}`;
  }
  const end = pts[pts.length - 1];
  return `${d} L${end.x} ${end.y}`;
}

function roundedTop(w: number, h: number, r: number): string {
  return `M0 ${h} V${r} Q0 0 ${r} 0 H${w - r} Q${w} 0 ${w} ${r} V${h} Z`;
}

/** The containers a node is drawn inside, for the layout input. */
export function visibleParent(ctx: RenderContext, node: GraphNode): string | undefined {
  return node.parent && isContainer(ctx.model, node.parent, ctx.expanded) ? node.parent : undefined;
}

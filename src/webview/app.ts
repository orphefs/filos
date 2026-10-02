// The review webview: owns the view state (expanded / selected / visited), turns it into a layout
// and a picture, and keeps the host informed. Rendering is idempotent: any state change goes
// through refresh(), which posts "rendered" when the picture matches the state.

import type { GraphNode, ReviewGraph } from '../contract/graph';
import type { ErrorAction, GraphSource, HostToWebview, ViewState } from '../protocol';
import { h } from './dom';
import { layoutGraph, type Direction, type Layout, type LayoutNodeInput, type Point } from './layout';
import { ancestors, buildModel, childrenOf, hasChildren, isContainer, liftEdges, visibleNodes, type Model, type VisibleEdge } from './model';
import { GraphView, HEADER_H, nodeSize, visibleParent, type RenderContext } from './render';
import { errorView, loadingView, waitingView } from './status';
import { renderSummary } from './summary';
import { resolveFonts, type Fonts } from './text';
import { Viewport } from './viewport';
import { loadPersisted, post, savePersisted } from './vscodeApi';

type Mode = 'waiting' | 'loading' | 'error' | 'graph';

/** Automatic fits stop here so labels stay readable (~8px text); the Fit button goes further. */
const AUTO_FIT_MIN = 0.62;

interface RefreshOptions {
  /** Keep this node at the same place on screen across the re-layout (the node the user clicked). */
  anchor?: string;
  /** Make sure this node is in view afterwards. */
  reveal?: string;
  fit?: boolean;
  animate?: boolean;
  /** Move keyboard focus to this node once it is drawn. */
  focus?: string;
}

export class App {
  private readonly root: HTMLElement;
  private readonly statusHost: HTMLElement;
  private readonly review: HTMLElement;
  private readonly titleEl: HTMLElement;
  private readonly metaEl: HTMLElement;
  private readonly warningsEl: HTMLElement;
  private readonly orientationEl: HTMLElement;
  private readonly graphHost: HTMLElement;
  private readonly summaryEl: HTMLElement;
  private readonly zoomReadout: HTMLElement;
  private readonly liveEl: HTMLElement;
  private readonly placeholder: HTMLElement;
  private readonly graph: GraphView;
  private readonly viewport: Viewport;
  private fonts: Fonts;

  private mode: Mode = 'waiting';
  private model?: Model;
  private source: GraphSource = 'fixture';
  private key = '';
  private expanded = new Set<string>();
  private selected?: string;
  private visited = new Set<string>();
  private seenBefore = false;
  private hoverId?: string;
  private needsFit = true;
  private seq = 0;
  /** Layouts by direction + input signature: re-selecting doesn't re-run ELK. */
  private layouts = new Map<string, Layout>();
  private direction: Direction = 'RIGHT';
  /** Pick the flow direction again on the next layout (new graph, or the pane changed shape). */
  private chooseDirection = true;
  private resizeTimer?: ReturnType<typeof setTimeout>;

  constructor(mount: HTMLElement) {
    this.graph = new GraphView({
      activate: (id) => this.activate(id),
      toggle: (id) => this.toggle(id),
      keydown: (id, ev) => this.onNodeKey(id, ev),
      hover: (id) => {
        this.hoverId = id;
        this.applyHighlight();
      },
    });

    const btn = (label: string, onClick: () => void, attrs: Record<string, string> = {}) => {
      const b = h('button', { type: 'button', class: 'tool', ...attrs }, label);
      b.addEventListener('click', onClick);
      return b;
    };
    this.zoomReadout = h('span', { class: 'zoom-readout', 'aria-live': 'off' }, '100%');
    const toolbar = h(
      'div',
      { class: 'toolbar', role: 'toolbar', 'aria-label': 'Graph controls' },
      btn('Expand all', () => this.expandAll()),
      btn('Collapse all', () => this.collapseAll()),
      h('span', { class: 'tool-sep', 'aria-hidden': 'true' }),
      btn('−', () => this.viewport.zoomBy(1 / 1.25), { 'aria-label': 'Zoom out', title: 'Zoom out' }),
      this.zoomReadout,
      btn('+', () => this.viewport.zoomBy(1.25), { 'aria-label': 'Zoom in', title: 'Zoom in' }),
      btn('Fit', () => this.viewport.fit(this.graph.bounds, true)),
      h('span', { class: 'tool-spacer' }),
      btn('Re-run analysis', () => post({ type: 'action', action: 'rerun' }), { class: 'tool tool--secondary' }),
    );

    this.placeholder = h('div', { class: 'graph-placeholder', role: 'status' }, 'Laying out the graph…');
    this.graphHost = h('div', { class: 'graph-host' }, this.graph.svg, this.placeholder);
    this.graph.trackFocus(this.graphHost);
    this.viewport = new Viewport(this.graph.svg, this.graph.world, {
      onChange: () => (this.zoomReadout.textContent = `${Math.round(this.viewport.k * 100)}%`),
      onBackgroundClick: () => this.clearSelection(),
    });

    this.titleEl = h('h1', { class: 'pr-title' });
    this.metaEl = h('div', { class: 'pr-meta' });
    this.warningsEl = h('ul', { class: 'warnings-list', hidden: true, id: 'filos-warnings' });
    this.orientationEl = h('p', { class: 'orientation' });
    this.summaryEl = h('div', { class: 'summary-scroll' });
    this.liveEl = h('div', { class: 'sr-only', 'aria-live': 'polite' });

    this.review = h(
      'div',
      { class: 'review', hidden: true },
      h('header', { class: 'topbar' }, this.titleEl, this.metaEl, this.warningsEl),
      h('section', { class: 'orientation-wrap', 'aria-label': 'Orientation' }, this.orientationEl),
      h(
        'div',
        { class: 'workspace' },
        h('section', { class: 'graph-pane', 'aria-label': 'Graph' }, toolbar, this.graphHost),
        h('aside', { class: 'summary-pane', 'aria-label': 'Summary' }, this.summaryEl),
      ),
    );
    this.statusHost = h('div', { class: 'status-host' }, waitingView());
    this.root = h('div', { class: 'filos' }, this.statusHost, this.review, this.liveEl);
    mount.append(this.root);
    this.fonts = resolveFonts(this.root);

    this.root.addEventListener('keydown', (ev) => {
      if (ev.key === 'Escape' && this.mode === 'graph' && this.selected) {
        ev.preventDefault();
        this.clearSelection();
      }
    });
    // When the host hands focus back after opening code, Chrome has already cleared the frame's
    // focused element; put it back on the selected node so arrow keys keep working.
    window.addEventListener('focus', () => {
      if (this.mode === 'graph' && this.selected && (!document.activeElement || document.activeElement === document.body)) {
        this.graph.focusNode(this.selected);
      }
    });
    new ResizeObserver(() => {
      if (this.mode !== 'graph' || !this.graph.bounds.width) return;
      if (!this.viewport.userMoved) this.autoFit();
      // Once the pane settles, check whether the other flow direction now reads better.
      clearTimeout(this.resizeTimer);
      this.resizeTimer = setTimeout(() => void this.reconsiderDirection(), 250);
    }).observe(this.graphHost);
  }

  // ---- host messages ------------------------------------------------------------------------

  handle(msg: HostToWebview): void {
    switch (msg.type) {
      case 'loading':
        this.showStatus('loading', loadingView(msg.message, msg.detail));
        break;
      case 'error':
        this.showStatus('error', errorView(msg.message, msg.detail, msg.actions ?? [], (a) => this.action(a)));
        break;
      case 'load':
        this.load(msg.graph, msg.source, msg.state, msg.warnings ?? []);
        break;
      case 'select':
        this.hostSelect(msg.id);
        break;
    }
  }

  private action(a: ErrorAction): void {
    post({ type: 'action', action: a });
  }

  private showStatus(mode: Mode, view: HTMLElement): void {
    this.mode = mode;
    this.statusHost.replaceChildren(view);
    this.statusHost.hidden = false;
    this.review.hidden = true;
  }

  private load(graph: ReviewGraph, source: GraphSource, state: ViewState | undefined, warnings: string[]): void {
    let model: Model;
    try {
      if (!graph || !Array.isArray(graph.nodes) || !graph.nodes.length) throw new Error('The graph has no nodes.');
      model = buildModel(graph);
    } catch (err) {
      this.showStatus('error', errorView('Could not show this review graph.', String(err), ['retry', 'useFixture'], (a) => this.action(a)));
      return;
    }
    this.model = model;
    this.source = source;
    this.key = `${graph.pr?.title ?? ''}\u0000${graph.pr?.head ?? ''}\u0000${graph.pr?.base ?? ''}`;
    this.layouts.clear();
    this.chooseDirection = true;

    // The host's state wins; fall back to what this webview remembered for the same PR.
    let view = state;
    const empty = !view || (!view.expanded?.length && !view.selected && !view.visited?.length);
    if (empty) {
      const saved = loadPersisted();
      if (saved && saved.key === this.key) view = saved.view;
    }
    const known = (id: string) => model.byId.has(id);
    this.expanded = new Set((view?.expanded ?? []).filter((id) => known(id) && hasChildren(model, id)));
    this.visited = new Set((view?.visited ?? []).filter(known));
    this.selected = view?.selected && known(view.selected) ? view.selected : undefined;
    if (this.selected) for (const a of ancestors(model, this.selected)) this.expanded.add(a);
    this.seenBefore = !!this.selected && this.visited.has(this.selected);
    if (this.selected) this.visited.add(this.selected);

    this.renderHeader(graph, source, warnings);
    this.mode = 'graph';
    this.statusHost.hidden = true;
    this.statusHost.replaceChildren();
    this.review.hidden = false;
    this.needsFit = true;
    this.placeholder.hidden = false;
    this.renderSummary();
    this.persist(false);
    void this.refresh({ fit: true, reveal: this.selected });
  }

  private renderHeader(graph: ReviewGraph, source: GraphSource, warnings: string[]): void {
    this.titleEl.textContent = graph.pr.title;
    const by = graph.generatedBy;
    const sourceText = source === 'fixture' ? 'Sample data' : `Generated by ${by?.provider ?? 'agent'}${by?.model ? ` (${by.model})` : ''}`;
    const parts: Node[] = [
      h('span', { class: 'branch', title: 'head → base' }, h('code', {}, graph.pr.head), ' → ', h('code', {}, graph.pr.base)),
    ];
    if (graph.pr.author) parts.push(h('span', { class: 'author' }, `by ${graph.pr.author}`));
    parts.push(h('span', { class: `source-badge source--${source}`, title: by?.at ? `Built ${by.at}` : '' }, sourceText));
    this.warningsEl.replaceChildren(...warnings.map((w) => h('li', {}, w)));
    this.warningsEl.hidden = true;
    if (warnings.length) {
      const t = h(
        'button',
        { type: 'button', class: 'warnings-toggle', 'aria-expanded': 'false', 'aria-controls': 'filos-warnings' },
        `${warnings.length} warning${warnings.length === 1 ? '' : 's'}`,
      );
      t.addEventListener('click', () => {
        this.warningsEl.hidden = !this.warningsEl.hidden;
        t.setAttribute('aria-expanded', String(!this.warningsEl.hidden));
      });
      parts.push(t);
    }
    this.metaEl.replaceChildren(...parts);
    this.orientationEl.textContent = graph.orientation;
  }

  // ---- interaction --------------------------------------------------------------------------

  /** Click / Enter / Space: select, and open a closed module. */
  private activate(id: string): void {
    const model = this.model;
    if (!model?.byId.has(id)) return;
    const opened = hasChildren(model, id) && !this.expanded.has(id);
    if (opened) this.expanded.add(id);
    this.setSelected(id, true);
    void this.refresh({ anchor: id, animate: opened });
  }

  /** The chevron: open/close without changing what is selected (unless the selection gets hidden). */
  private toggle(id: string): void {
    if (this.expanded.has(id)) this.collapse(id);
    else this.activate(id);
  }

  private expand(id: string): void {
    if (!this.model || !hasChildren(this.model, id) || this.expanded.has(id)) return;
    this.expanded.add(id);
    this.persist(true);
    void this.refresh({ anchor: id, animate: true });
  }

  private collapse(id: string): void {
    if (!this.model || !this.expanded.has(id)) return;
    this.expanded.delete(id);
    // A selection hidden inside the closed module moves up to it, so the summary matches the picture.
    if (this.selected && ancestors(this.model, this.selected).includes(id)) this.setSelected(id, true);
    else this.persist(true);
    void this.refresh({ anchor: id, animate: true });
  }

  private expandAll(): void {
    if (!this.model) return;
    for (const n of this.model.graph.nodes) if (hasChildren(this.model, n.id)) this.expanded.add(n.id);
    this.persist(true);
    // The whole picture changes, so re-pick the direction and skip the slide.
    this.chooseDirection = true;
    void this.refresh({ fit: true });
  }

  private collapseAll(): void {
    if (!this.model) return;
    this.expanded.clear();
    this.chooseDirection = true;
    const sel = this.selected;
    const top = sel ? [sel, ...ancestors(this.model, sel)].pop()! : undefined;
    if (top && top !== sel) this.setSelected(top, true);
    else this.persist(true);
    void this.refresh({ fit: true });
  }

  private clearSelection(): void {
    if (!this.selected) return;
    const was = this.selected;
    // If focus was in the summary (now rebuilt), park it on the node the user was looking at.
    const focusInSummary = this.summaryEl.contains(document.activeElement);
    this.selected = undefined;
    this.seenBefore = false;
    this.liveEl.textContent = 'Showing the overview';
    this.renderSummary();
    this.persist(true);
    void this.refresh({ focus: focusInSummary ? was : undefined });
  }

  private hostSelect(id: string): void {
    if (!this.model?.byId.has(id)) {
      console.warn(`[filos] host asked to select unknown node "${id}"`);
      return;
    }
    for (const a of ancestors(this.model, id)) this.expanded.add(a);
    // Same as a click: selecting a closed module also opens it.
    if (hasChildren(this.model, id)) this.expanded.add(id);
    this.setSelected(id, false);
    void this.refresh({ reveal: id, animate: true });
  }

  /** Selection from the summary pane: reveal it in the graph. */
  private selectFromSummary(id: string): void {
    if (!this.model?.byId.has(id)) return;
    for (const a of ancestors(this.model, id)) this.expanded.add(a);
    this.setSelected(id, true);
    // The summary is about to be rebuilt under the clicked link, so focus moves to the node.
    void this.refresh({ reveal: id, animate: true, focus: id });
  }

  /**
   * @param tellHost post "select" so the host opens the code (user-driven selections only;
   * the host already knows about the ones it asked for).
   */
  private setSelected(id: string, tellHost: boolean): void {
    this.seenBefore = this.visited.has(id);
    this.selected = id;
    this.visited.add(id);
    if (tellHost) post({ type: 'select', id });
    this.liveEl.textContent = `Selected ${this.model?.byId.get(id)?.label ?? id}`;
    this.renderSummary();
    this.persist(true);
  }

  private onNodeKey(id: string, ev: KeyboardEvent): void {
    const model = this.model;
    if (!model) return;
    const order = visibleNodes(model, this.expanded).map((n) => n.id);
    const i = order.indexOf(id);
    const focus = (target: string | undefined) => {
      if (!target) return;
      this.graph.focusNode(target);
      const box = this.graph.boxes.get(target);
      if (box) this.viewport.ensureVisible(box, true);
    };
    switch (ev.key) {
      case 'Enter':
      case ' ':
        ev.preventDefault();
        this.activate(id);
        break;
      case 'ArrowRight':
        ev.preventDefault();
        if (hasChildren(model, id) && !this.expanded.has(id)) this.expand(id);
        else if (isContainer(model, id, this.expanded)) focus(childrenOf(model, id)[0]?.id);
        break;
      case 'ArrowLeft':
        ev.preventDefault();
        if (isContainer(model, id, this.expanded)) this.collapse(id);
        else focus(model.byId.get(id)?.parent);
        break;
      case 'ArrowDown':
        ev.preventDefault();
        focus(order[Math.min(order.length - 1, i + 1)]);
        break;
      case 'ArrowUp':
        ev.preventDefault();
        focus(order[Math.max(0, i - 1)]);
        break;
      case 'Home':
        ev.preventDefault();
        focus(order[0]);
        break;
      case 'End':
        ev.preventDefault();
        focus(order[order.length - 1]);
        break;
    }
  }

  // ---- state -------------------------------------------------------------------------------

  private viewState(): ViewState {
    return { expanded: [...this.expanded], selected: this.selected, visited: [...this.visited] };
  }

  private persist(notifyHost: boolean): void {
    const view = this.viewState();
    savePersisted({ v: 1, key: this.key, view });
    if (notifyHost) post({ type: 'stateChanged', state: view });
  }

  private ctx(): RenderContext {
    return { model: this.model!, expanded: this.expanded, selected: this.selected, visited: this.visited, fonts: this.fonts };
  }

  private renderSummary(): void {
    if (!this.model) return;
    renderSummary(
      this.summaryEl,
      { model: this.model, source: this.source, selected: this.selected, seenBefore: this.seenBefore },
      {
        select: (id) => this.selectFromSummary(id),
        openAnchor: (id, anchorIndex) => post({ type: 'openAnchor', id, anchorIndex }),
        clearSelection: () => this.clearSelection(),
      },
    );
  }

  private applyHighlight(): void {
    const model = this.model;
    const focus = this.hoverId ?? this.selected;
    if (!model || !focus) return this.graph.highlight(undefined, undefined);
    // A container stands for everything drawn inside it; edge labels only for the node itself.
    const ids = new Set([focus]);
    for (const n of visibleNodes(model, this.expanded)) if (ancestors(model, n.id).includes(focus)) ids.add(n.id);
    this.graph.highlight(ids, focus);
  }

  // ---- layout + render ---------------------------------------------------------------------

  /**
   * Fit for readability: never below AUTO_FIT_MIN. If that crops the graph, keep the node that
   * matters in view: the one asked for, else the selection, else the riskiest visible node.
   */
  private autoFit(animate = false, reveal?: string): void {
    this.viewport.fit(this.graph.bounds, animate, AUTO_FIT_MIN);
    const cropped = this.viewport.fitScale(this.graph.bounds) < AUTO_FIT_MIN;
    const id = reveal ?? (cropped ? (this.selected ?? this.riskiest(visibleNodes(this.model!, this.expanded))) : undefined);
    const box = id ? this.graph.boxes.get(id) : undefined;
    if (box) this.viewport.ensureVisible(box, animate);
  }

  private riskiest(nodes: GraphNode[]): string | undefined {
    let best: { id: string; level: number } | undefined;
    for (const n of nodes) {
      const level = n.kind === 'external' ? -1 : (this.model?.risk.get(n.id)?.level ?? 0);
      if (!best || level > best.level) best = { id: n.id, level };
    }
    return best?.id;
  }

  private async layoutFor(sig: string, inputs: LayoutNodeInput[], edges: VisibleEdge[], direction: Direction): Promise<Layout> {
    const key = `${direction}\u0000${sig}`;
    const hit = this.layouts.get(key);
    if (hit) return hit;
    const layout = await layoutGraph(inputs, edges.map((e) => ({ id: e.id, from: e.from, to: e.to })), direction);
    if (this.layouts.size > 64) this.layouts.clear(); // bounded: states are few, but don't grow forever
    this.layouts.set(key, layout);
    return layout;
  }

  private layoutInputs(): { visible: GraphNode[]; inputs: LayoutNodeInput[]; edges: VisibleEdge[]; sig: string } {
    const model = this.model!;
    const ctx = this.ctx();
    const visible = visibleNodes(model, this.expanded);
    const inputs = visible.map((n) => ({
      id: n.id,
      parent: visibleParent(ctx, n),
      ...nodeSize(n, ctx),
      container: isContainer(model, n.id, this.expanded),
      headerHeight: HEADER_H + 10,
    }));
    const edges = liftEdges(model, this.expanded);
    return { visible, inputs, edges, sig: JSON.stringify([inputs, edges.map((e) => [e.id, e.from, e.to])]) };
  }

  /**
   * Lays out both ways and keeps the one that can be drawn larger in this pane. Left-to-right
   * (the default) wins unless top-down is clearly more readable, e.g. in a narrow panel.
   */
  private async bestLayout(sig: string, inputs: LayoutNodeInput[], edges: VisibleEdge[]): Promise<Layout> {
    const [right, down] = await Promise.all([this.layoutFor(sig, inputs, edges, 'RIGHT'), this.layoutFor(sig, inputs, edges, 'DOWN')]);
    const size = (l: Layout) => this.viewport.fitScale({ x: 0, y: 0, width: l.width, height: l.height });
    return size(down) > size(right) * 1.15 ? down : right;
  }

  /** After a resize: re-render only if the other direction now reads clearly better. */
  private async reconsiderDirection(): Promise<void> {
    if (!this.model || this.mode !== 'graph') return;
    const { sig, inputs, edges } = this.layoutInputs();
    try {
      const best = await this.bestLayout(sig, inputs, edges);
      if (best.direction !== this.direction && this.mode === 'graph') {
        this.chooseDirection = true;
        void this.refresh({ fit: true });
      }
    } catch {
      // A real layout failure is reported by the next refresh.
    }
  }

  private async refresh(opts: RefreshOptions): Promise<void> {
    const model = this.model;
    if (!model || this.mode !== 'graph') return;
    const seq = ++this.seq;
    const ctx = this.ctx();
    const { visible, inputs, edges, sig } = this.layoutInputs();

    let layout: Layout;
    try {
      layout = this.chooseDirection ? await this.bestLayout(sig, inputs, edges) : await this.layoutFor(sig, inputs, edges, this.direction);
    } catch (err) {
      console.error('[filos] layout failed', err);
      this.showStatus('error', errorView('Could not lay out the graph.', err instanceof Error ? `${err.message}\n${err.stack ?? ''}` : String(err), ['retry'], (a) => this.action(a)));
      return;
    }
    if (seq !== this.seq) return; // a newer refresh superseded this one
    const flipped = layout.direction !== this.direction;
    this.direction = layout.direction;
    this.chooseDirection = false;

    let anchorScreen: Point | undefined;
    const before = opts.anchor ? this.graph.boxes.get(opts.anchor) : undefined;
    if (before) anchorScreen = this.viewport.toScreen(before);

    const fit = this.needsFit || !!opts.fit || flipped;
    const animate = !!opts.animate && !this.needsFit && !flipped && !matchMedia('(prefers-reduced-motion: reduce)').matches;
    this.graph.render(ctx, visible, layout, edges, animate);
    this.placeholder.hidden = true;
    this.applyHighlight();

    if (fit) {
      this.needsFit = false;
      this.autoFit(animate, opts.reveal);
    } else {
      const after = opts.anchor ? this.graph.boxes.get(opts.anchor) : undefined;
      if (after && anchorScreen) this.viewport.pin(after, anchorScreen, animate);
      const target = this.graph.boxes.get(opts.anchor ?? opts.reveal ?? '');
      if (target) this.viewport.ensureVisible(target, animate);
    }

    if (opts.focus) this.graph.focusNode(opts.focus);
    post({ type: 'rendered', visibleNodes: visible.map((n) => n.id), expanded: [...this.expanded], selected: this.selected });
  }
}

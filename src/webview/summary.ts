// The contextual summary beside the graph. With nothing selected it orients (PR overview, where
// to look first, legend); with a node selected it explains that node: why it is coloured the way
// it is, what it touches, and links to its code.

import type { GraphEdge, GraphNode } from '../contract/graph';
import type { RiskContribution, RiskScore } from '../contract/risk';
import type { GraphSource } from '../protocol';
import { h, onActivate } from './dom';
import { buildLegend } from './legend';
import { ancestors, CHANGE_WORD, childrenOf, describeChildren, type Model } from './model';
import { verb } from './render';

export interface SummaryHandlers {
  select(id: string): void;
  openAnchor(id: string, anchorIndex: number): void;
  clearSelection(): void;
}

export interface SummaryContext {
  model: Model;
  source: GraphSource;
  selected?: string;
  /** The selected node had been looked at before this selection. */
  seenBefore: boolean;
}

const CODE_KINDS = new Set(['function', 'class', 'type']);

const points = (p: number) => (p < 0.005 ? '+<0.01' : `+${p.toFixed(2)}`);

function nodeName(n: GraphNode): HTMLElement {
  return h('span', { class: CODE_KINDS.has(n.kind) ? 'code-name' : 'plain-name' }, n.label);
}

function bandPill(risk: RiskScore | undefined): HTMLElement | null {
  if (!risk) return null;
  const word = risk.band[0].toUpperCase() + risk.band.slice(1);
  return h('span', { class: `band-pill band-${risk.band}` }, `${word} risk`);
}

function nodeButton(n: GraphNode, model: Model, handlers: SummaryHandlers, extra?: string): HTMLElement {
  const risk = n.kind === 'external' ? undefined : model.risk.get(n.id);
  const name = `${n.label}, ${n.kind === 'external' ? 'outside this repo' : `${risk?.band ?? 'unknown'} risk`}${extra ? `, ${extra}` : ''}`;
  const b = h(
    'button',
    { class: `node-link${n.kind === 'external' ? ' node-link--external' : ''}`, type: 'button', 'data-select': n.id, 'aria-label': name },
    nodeName(n),
    n.kind === 'external' ? h('span', { class: 'outside-tag' }, 'outside this repo') : bandPill(risk),
    extra ? h('span', { class: 'node-link-extra' }, extra) : null,
  );
  onActivate(b, () => handlers.select(n.id));
  return b;
}

export function renderSummary(root: HTMLElement, ctx: SummaryContext, handlers: SummaryHandlers): void {
  const node = ctx.selected ? ctx.model.byId.get(ctx.selected) : undefined;
  root.replaceChildren(...(node ? selectedView(node, ctx, handlers) : overview(ctx, handlers)));
  root.scrollTop = 0;
}

function overview(ctx: SummaryContext, handlers: SummaryHandlers): Node[] {
  const { model } = ctx;
  const nodes = model.graph.nodes;
  const modules = nodes.filter((n) => n.kind === 'module').length;
  const symbols = nodes.filter((n) => n.kind !== 'module' && n.kind !== 'external' && n.kind !== 'file');
  const changed = symbols.filter((n) => n.change !== 'context').length;
  const externals = nodes.filter((n) => n.kind === 'external').length;

  const firstLook = symbols
    .filter((n) => !childrenOf(model, n.id).length)
    .sort((a, b) => (model.risk.get(b.id)?.level ?? 0) - (model.risk.get(a.id)?.level ?? 0))
    .slice(0, 4);

  const stats = h(
    'ul',
    { class: 'stats' },
    h('li', {}, h('strong', {}, String(modules)), modules === 1 ? ' module' : ' modules'),
    h('li', {}, h('strong', {}, String(changed)), changed === 1 ? ' changed symbol' : ' changed symbols'),
    externals ? h('li', { class: 'stat-external' }, h('strong', {}, String(externals)), externals === 1 ? ' repo outside uses this' : ' repos outside use this') : null,
  );

  return [
    h('p', { class: 'eyebrow' }, 'Overview'),
    h('h2', { class: 'summary-title' }, 'What this PR touches'),
    stats,
    h('h3', {}, 'Where to look first'),
    h('p', { class: 'muted small' }, 'Riskiest first, by countable signals. Pick one to see its code.'),
    h(
      'ol',
      { class: 'first-look' },
      ...firstLook.map((n) => h('li', {}, nodeButton(n, model, handlers), h('p', { class: 'why' }, n.risk.why))),
    ),
    h('h3', {}, 'How to read the graph'),
    buildLegend(),
    h(
      'p',
      { class: 'muted small tips' },
      'Drag to pan, scroll to zoom. Keyboard: Tab between boxes, Enter to open, → expand, ← collapse, Esc back to this overview.',
    ),
  ];
}

function selectedView(node: GraphNode, ctx: SummaryContext, handlers: SummaryHandlers): Node[] {
  const { model } = ctx;
  const out: Node[] = [];

  // Breadcrumb: where this sits, each step clickable.
  const crumbs = h('nav', { class: 'crumbs', 'aria-label': 'Location' });
  const back = h('button', { class: 'crumb', type: 'button' }, 'Overview');
  onActivate(back, () => handlers.clearSelection());
  crumbs.append(back);
  for (const id of ancestors(model, node.id).reverse()) {
    const a = model.byId.get(id)!;
    const b = h('button', { class: 'crumb', type: 'button', 'data-select': id }, a.label);
    onActivate(b, () => handlers.select(id));
    crumbs.append(h('span', { class: 'crumb-sep', 'aria-hidden': 'true' }, '›'), b);
  }
  out.push(crumbs);

  const isExternal = node.kind === 'external';
  const kindText = isExternal ? 'outside this repo' : node.kind;
  out.push(
    h(
      'div',
      { class: 'summary-head' },
      h('h2', { class: `summary-title${CODE_KINDS.has(node.kind) ? ' code-name' : ''}` }, node.label),
      h(
        'div',
        { class: 'head-tags' },
        h('span', { class: `kind-tag${isExternal ? ' kind-tag--external' : ''}` }, kindText),
        isExternal ? null : h('span', { class: `change-badge change--${node.change}` }, CHANGE_WORD[node.change].toUpperCase()),
        h('span', { class: `seen-tag${ctx.seenBefore ? ' is-seen' : ''}` }, ctx.seenBefore ? '✓ Seen before' : 'First look'),
      ),
    ),
  );

  if (!isExternal) out.push(riskSection(node, ctx, handlers));
  out.push(h('p', { class: 'summary-text' }, node.summary));

  const kids = childrenOf(model, node.id);
  if (kids.length) {
    out.push(h('h3', {}, `Inside (${describeChildren(model, node.id)})`));
    const sorted = [...kids].sort((a, b) => (model.risk.get(b.id)?.level ?? 0) - (model.risk.get(a.id)?.level ?? 0));
    out.push(h('ul', { class: 'link-list' }, ...sorted.map((k) => h('li', {}, nodeButton(k, model, handlers, CHANGE_WORD[k.change])))));
  }

  out.push(...codeSection(node, handlers));
  out.push(...connections(node, ctx, handlers));

  out.push(h('details', { class: 'legend-details' }, h('summary', {}, 'How to read the graph'), buildLegend()));
  return out;
}

function riskSection(node: GraphNode, ctx: SummaryContext, handlers: SummaryHandlers): HTMLElement {
  const risk = ctx.model.risk.get(node.id)!;
  const own = risk.contributions;
  const total = own.reduce((s, c) => s + c.points, 0);
  const sec = h('section', { class: `risk-card band-${risk.band}`, 'aria-label': 'Risk' });
  sec.append(
    h(
      'div',
      { class: 'risk-head' },
      bandPill(risk),
      h('span', { class: 'risk-score', title: 'Risk score, 0 to 1' }, risk.level.toFixed(2)),
    ),
  );

  if (risk.inheritedFrom) {
    const from = ctx.model.byId.get(risk.inheritedFrom);
    const fromScore = ctx.model.risk.get(risk.inheritedFrom);
    const link = h('button', { class: 'inline-link', type: 'button', 'data-select': risk.inheritedFrom }, from?.label ?? risk.inheritedFrom);
    onActivate(link, () => handlers.select(risk.inheritedFrom!));
    sec.append(
      h('p', { class: 'risk-inherited' }, 'Coloured by its riskiest part, ', link, ` (${fromScore?.level.toFixed(2) ?? '?'}). On its own it scores ${total.toFixed(2)}.`),
    );
  }

  sec.append(contributionBar(own));
  const chips = h('ul', { class: 'chips', 'aria-label': 'What the score is made of' });
  for (const c of [...own].sort((a, b) => b.points - a.points)) {
    chips.append(h('li', { class: `chip chip--${c.signal}` }, c.label, ' ', h('span', { class: 'chip-points' }, points(c.points))));
  }
  const sig = node.risk.signals;
  // Not scored, but a reviewer wants to know: did the tests move with the code?
  if (sig.hasTests && sig.testsChanged === false) chips.append(h('li', { class: 'chip chip--note' }, 'tests not updated'));
  if (sig.testsChanged) chips.append(h('li', { class: 'chip chip--note' }, 'tests updated'));
  if (sig.externalConsumers === undefined && node.kind !== 'module') {
    chips.append(h('li', { class: 'chip chip--unknown', title: 'No dependency index, so consumers outside this repo are unknown' }, 'outside consumers unknown'));
  }
  if (chips.childElementCount) sec.append(chips);
  sec.append(h('p', { class: 'why' }, node.risk.why));
  return sec;
}

/** The score as a bar from 0 to 1, one segment per signal, with the band thresholds marked. */
function contributionBar(contribs: RiskContribution[]): HTMLElement {
  const bar = h('div', { class: 'score-bar', 'aria-hidden': 'true' });
  const track = h('div', { class: 'score-track' });
  let i = 0;
  for (const c of [...contribs].sort((a, b) => b.points - a.points)) {
    const seg = h('span', { class: `score-seg seg-${i++ % 4}`, title: `${c.label}: ${points(c.points)}` });
    seg.style.width = `${Math.min(100, c.points * 100)}%`;
    track.append(seg);
  }
  bar.append(
    track,
    h('span', { class: 'score-tick tick-medium' }),
    h('span', { class: 'score-tick tick-high' }),
    h('div', { class: 'score-ticks' }, h('span', { class: 'tick-label tick-label-medium' }, 'medium'), h('span', { class: 'tick-label tick-label-high' }, 'high')),
  );
  return bar;
}

function codeSection(node: GraphNode, handlers: SummaryHandlers): Node[] {
  if (node.kind === 'external') {
    return [h('h3', {}, 'Code'), h('p', { class: 'muted' }, `Not in this repo: ${node.label} has its own codebase. The lines below show where it touches this one.`)];
  }
  if (!node.anchors.length) return [h('h3', {}, 'Code'), h('p', { class: 'muted' }, 'No code anchored to this node.')];
  const list = h('ul', { class: 'anchors' });
  node.anchors.forEach((a, i) => {
    const lines = a.startLine === a.endLine ? `${a.startLine}` : `${a.startLine}–${a.endLine}`;
    const isTest = /(^|\/)(test|tests|__tests__)\//.test(a.file) || /\.(test|spec)\.[jt]sx?$/.test(a.file);
    const link = h(
      'a',
      { class: 'anchor-link', href: '#', 'data-anchor-index': i },
      h('span', { class: 'anchor-file' }, `${a.file}:${lines}`),
    );
    onActivate(link, () => handlers.openAnchor(node.id, i));
    list.append(
      h(
        'li',
        {},
        link,
        a.symbol ? h('span', { class: 'anchor-symbol' }, a.symbol) : null,
        isTest ? h('span', { class: 'anchor-tag' }, 'test') : i === 0 ? h('span', { class: 'anchor-tag' }, 'main') : null,
      ),
    );
  });
  return [h('h3', {}, 'Code'), list];
}

/** Edges crossing this node's boundary: what it uses and what uses it. */
function connections(node: GraphNode, ctx: SummaryContext, handlers: SummaryHandlers): Node[] {
  const { model } = ctx;
  const inside = (id: string) => id === node.id || ancestors(model, id).includes(node.id);
  const uses: GraphEdge[] = [];
  const usedBy: GraphEdge[] = [];
  for (const e of model.graph.edges) {
    const a = inside(e.from);
    const b = inside(e.to);
    if (a && !b) uses.push(e);
    else if (b && !a) usedBy.push(e);
  }
  const item = (e: GraphEdge, other: string, self: string) => {
    const o = model.byId.get(other);
    if (!o) return null;
    const via = self !== node.id ? model.byId.get(self)?.label : undefined;
    const detail = [via ? `via ${via}` : '', e.label ?? ''].filter(Boolean).join(' · ');
    return h('li', {}, nodeButton(o, model, handlers), detail ? h('span', { class: 'edge-detail' }, detail) : null);
  };
  const out: Node[] = [];
  const outside = usedBy.filter((e) => model.byId.get(e.from)?.kind === 'external');
  const inRepo = usedBy.filter((e) => model.byId.get(e.from)?.kind !== 'external');
  if (outside.length) {
    const repos = new Set(outside.map((e) => e.from)).size;
    out.push(h('h3', { class: 'h-external' }, `Used outside this repo (${repos} ${repos === 1 ? 'repo' : 'repos'})`));
    out.push(h('ul', { class: 'link-list' }, ...outside.map((e) => item(e, e.from, e.to))));
  }
  if (inRepo.length) {
    out.push(h('h3', {}, 'Used by'));
    out.push(h('ul', { class: 'link-list' }, ...inRepo.map((e) => item(e, e.from, e.to))));
  }
  if (uses.length) {
    out.push(h('h3', {}, node.kind === 'external' ? 'Uses from this repo' : 'Depends on'));
    out.push(
      h(
        'ul',
        { class: 'link-list' },
        ...uses.map((e) => {
          const li = item(e, e.to, e.from);
          li?.setAttribute('data-verb', verb(e.kind));
          return li;
        }),
      ),
    );
  }
  return out;
}

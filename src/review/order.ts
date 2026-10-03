// Which territory a node belongs to, and the order questions are asked in: riskiest territory
// first, predictions before checks, riskier nodes first within a stage. Pure, so the webview
// harness and unit tests can run it.

import type { GraphNode, ReviewGraph } from '../contract/graph';
import { DEPTHS, type Depth, type Question } from '../contract/questions';
import { scoreGraph, type RiskScore } from '../contract/risk';

/** skim ⊂ standard ⊂ deep: a question tagged `depth` is asked at `chosen` when it's no deeper. */
export function includesDepth(chosen: Depth, depth: Depth): boolean {
  return DEPTHS.indexOf(depth) <= DEPTHS.indexOf(chosen);
}

export function isDepth(value: unknown): value is Depth {
  return typeof value === 'string' && (DEPTHS as readonly string[]).includes(value);
}

/** Hierarchy and risk lookups the review model needs, built once per graph. */
export class GraphIndex {
  readonly byId: Map<string, GraphNode>;
  /** Top-level module nodes, in graph order: the territories of the didactic map. */
  readonly territories: GraphNode[];
  readonly risk: Map<string, RiskScore>;
  private readonly order: Map<string, number>;
  private readonly children = new Map<string, GraphNode[]>();
  private readonly territoryCache = new Map<string, string | undefined>();
  private readonly linkCache = new Map<string, string[]>();

  constructor(readonly graph: ReviewGraph) {
    this.byId = new Map(graph.nodes.map((n) => [n.id, n] as const));
    this.order = new Map(graph.nodes.map((n, i) => [n.id, i] as const));
    this.risk = scoreGraph(graph);
    for (const n of graph.nodes) {
      if (!n.parent || !this.byId.has(n.parent)) continue;
      const list = this.children.get(n.parent) ?? [];
      list.push(n);
      this.children.set(n.parent, list);
    }
    this.territories = graph.nodes.filter((n) => n.kind === 'module' && !(n.parent && this.byId.has(n.parent)));
  }

  /** The root of a node's parent chain (the node itself if top level). Cycle-safe. */
  root(id: string): string | undefined {
    if (!this.byId.has(id)) return undefined;
    const seen = new Set<string>([id]);
    let cur = id;
    for (;;) {
      const parent = this.byId.get(cur)?.parent;
      if (!parent || !this.byId.has(parent) || seen.has(parent)) return cur;
      seen.add(parent);
      cur = parent;
    }
  }

  /** Steps from the root (0 for top-level nodes). */
  depthOf(id: string): number {
    let d = 0;
    const seen = new Set<string>([id]);
    let cur = this.byId.get(id)?.parent;
    while (cur && this.byId.has(cur) && !seen.has(cur)) {
      seen.add(cur);
      d++;
      cur = this.byId.get(cur)?.parent;
    }
    return d;
  }

  /** The territory (top-level module) containing a node, or undefined for externals and unknown ids. */
  territoryOf(id: string): string | undefined {
    if (this.territoryCache.has(id)) return this.territoryCache.get(id);
    const root = this.root(id);
    const t = root && this.byId.get(root)?.kind === 'module' ? root : undefined;
    this.territoryCache.set(id, t);
    return t;
  }

  isTerritory(id: string): boolean {
    return this.territoryOf(id) === id;
  }

  /** All nodes below `id`, depth first, in graph order. */
  descendants(id: string): GraphNode[] {
    const out: GraphNode[] = [];
    const seen = new Set<string>([id]);
    const walk = (pid: string) => {
      for (const c of this.children.get(pid) ?? []) {
        if (seen.has(c.id)) continue;
        seen.add(c.id);
        out.push(c);
        walk(c.id);
      }
    };
    walk(id);
    return out;
  }

  riskOf(id: string): number {
    return this.risk.get(id)?.level ?? 0;
  }

  indexOf(id: string): number {
    return this.order.get(id) ?? Number.MAX_SAFE_INTEGER;
  }

  /**
   * Territories an external is linked to by an edge, either way (it "consumes" their symbols, or
   * something in them "affects" it), riskiest first. Empty for nodes that aren't externals.
   */
  linkedTerritories(id: string): string[] {
    const cached = this.linkCache.get(id);
    if (cached) return [...cached];
    const linked = new Set<string>();
    if (this.byId.get(id)?.kind === 'external') {
      for (const e of this.graph.edges) {
        const other = e.from === id ? e.to : e.to === id ? e.from : undefined;
        const t = other !== undefined ? this.territoryOf(other) : undefined;
        if (t) linked.add(t);
      }
    }
    const out = [...linked].sort((a, b) => this.riskOf(b) - this.riskOf(a) || this.indexOf(a) - this.indexOf(b));
    this.linkCache.set(id, out);
    return [...out];
  }

  /**
   * Where a node's questions are grouped: its territory; for an external consumer, the riskiest
   * territory it's linked to (so "should checkout-web pin half-up?" sits with money); otherwise its root.
   */
  groupOf(id: string): string {
    return this.territoryOf(id) ?? this.linkedTerritories(id)[0] ?? this.root(id) ?? id;
  }
}

/**
 * Didactic fog: whether a node can be seen and asked about. Inside a territory, once that territory
 * is explored. An external, once a territory it's linked to is explored (always, if it has none).
 * Anything else top level (not a module), always. Unknown ids, never.
 */
export function isRevealed(index: GraphIndex, explored: ReadonlySet<string>, id: string): boolean {
  if (!index.byId.has(id)) return false;
  const territory = index.territoryOf(id);
  if (territory) return explored.has(territory);
  const linked = index.linkedTerritories(id);
  return !linked.length || linked.some((t) => explored.has(t));
}

/**
 * Questions at `depth`, in asking order. Questions about unknown nodes and repeated ids are dropped
 * (the validator rejects both; this keeps the model safe if one slips through).
 *
 * Order: groups (territories) by risk, riskiest first; within a group, predict before check; within
 * a stage, riskier node first, then shallower node, then graph order, then question-set order.
 */
export function orderQuestions(index: GraphIndex, questions: readonly Question[], depth: Depth): Question[] {
  const seen = new Set<string>();
  const keep: { q: Question; i: number }[] = [];
  questions.forEach((q, i) => {
    if (seen.has(q.id) || !index.byId.has(q.nodeId)) return;
    seen.add(q.id);
    if (includesDepth(depth, q.depth)) keep.push({ q, i });
  });

  const groups = [...new Set(keep.map(({ q }) => index.groupOf(q.nodeId)))];
  groups.sort((a, b) => index.riskOf(b) - index.riskOf(a) || index.indexOf(a) - index.indexOf(b));
  const groupRank = new Map(groups.map((g, i) => [g, i] as const));

  const key = ({ q, i }: { q: Question; i: number }): number[] => [
    groupRank.get(index.groupOf(q.nodeId)) ?? 0,
    q.stage === 'predict' ? 0 : 1,
    -index.riskOf(q.nodeId),
    index.depthOf(q.nodeId),
    index.indexOf(q.nodeId),
    i,
  ];
  return keep
    .map((k) => ({ q: k.q, key: key(k) }))
    .sort((a, b) => {
      for (let j = 0; j < a.key.length; j++) if (a.key[j] !== b.key[j]) return a.key[j] - b.key[j];
      return 0;
    })
    .map((k) => k.q);
}

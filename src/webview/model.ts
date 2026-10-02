// Read-only view of a ReviewGraph for the renderer: hierarchy lookups, what is visible for a
// given set of expanded nodes, and edges lifted to the nearest visible ancestor.

import type { EdgeKind, GraphEdge, GraphNode, NodeKind, ReviewGraph } from '../contract/graph';
import { scoreGraph, type RiskScore } from '../contract/risk';

export interface Model {
  graph: ReviewGraph;
  byId: Map<string, GraphNode>;
  /** Children per parent id, in graph order. */
  children: Map<string, GraphNode[]>;
  /** Top-level nodes (modules and externals), in graph order. */
  roots: GraphNode[];
  risk: Map<string, RiskScore>;
  /** Distinct external nodes consuming each node or anything inside it. */
  externalsOf: Map<string, Set<string>>;
}

export function buildModel(graph: ReviewGraph): Model {
  const byId = new Map(graph.nodes.map((n) => [n.id, n] as const));
  const children = new Map<string, GraphNode[]>();
  const roots: GraphNode[] = [];
  for (const n of graph.nodes) {
    if (n.parent && byId.has(n.parent)) {
      const list = children.get(n.parent) ?? [];
      list.push(n);
      children.set(n.parent, list);
    } else {
      roots.push(n);
    }
  }
  const model: Model = { graph, byId, children, roots, risk: scoreGraph(graph), externalsOf: new Map() };

  for (const e of graph.edges) {
    const from = byId.get(e.from);
    if (!from || from.kind !== 'external' || !byId.has(e.to)) continue;
    for (const id of [e.to, ...ancestors(model, e.to)]) {
      const set = model.externalsOf.get(id) ?? new Set<string>();
      set.add(from.id);
      model.externalsOf.set(id, set);
    }
  }
  return model;
}

/** Ancestor ids, nearest first. Guards against cycles even though the validator rejects them. */
export function ancestors(model: Model, id: string): string[] {
  const out: string[] = [];
  let cur = model.byId.get(id)?.parent;
  while (cur && model.byId.has(cur) && !out.includes(cur)) {
    out.push(cur);
    cur = model.byId.get(cur)?.parent;
  }
  return out;
}

export function childrenOf(model: Model, id: string): GraphNode[] {
  return model.children.get(id) ?? [];
}

export function hasChildren(model: Model, id: string): boolean {
  return childrenOf(model, id).length > 0;
}

export function isVisible(model: Model, id: string, expanded: ReadonlySet<string>): boolean {
  return model.byId.has(id) && ancestors(model, id).every((a) => expanded.has(a));
}

/** Visible nodes in tree order (parent, then its children), which is also the keyboard order. */
export function visibleNodes(model: Model, expanded: ReadonlySet<string>): GraphNode[] {
  const out: GraphNode[] = [];
  const walk = (n: GraphNode) => {
    out.push(n);
    if (expanded.has(n.id)) childrenOf(model, n.id).forEach(walk);
  };
  model.roots.forEach(walk);
  return out;
}

/** The node itself if visible, otherwise its nearest visible ancestor. */
export function visibleAncestor(model: Model, id: string, expanded: ReadonlySet<string>): string {
  const chain = [id, ...ancestors(model, id)].reverse(); // root first
  for (let i = 0; i < chain.length - 1; i++) {
    if (!expanded.has(chain[i])) return chain[i];
  }
  return id;
}

/** A node shown as a container: expanded and with children to show. */
export function isContainer(model: Model, id: string, expanded: ReadonlySet<string>): boolean {
  return expanded.has(id) && hasChildren(model, id);
}

export interface VisibleEdge {
  id: string;
  from: string;
  to: string;
  /** Most important kind among the merged edges (consumes > calls > imports > affects > tests). */
  kind: EdgeKind;
  /** The contract edges this one stands for. */
  edges: GraphEdge[];
  /** True when either end was moved up to a collapsed ancestor. */
  lifted: boolean;
}

const KIND_RANK: Record<EdgeKind, number> = { consumes: 0, calls: 1, imports: 2, affects: 3, tests: 4 };

/**
 * Edges between visible nodes. An endpoint hidden inside a collapsed node moves to that node;
 * duplicates merge; self-loops and edges between a node and its own container are dropped.
 */
export function liftEdges(model: Model, expanded: ReadonlySet<string>): VisibleEdge[] {
  const merged = new Map<string, VisibleEdge>();
  for (const e of model.graph.edges) {
    if (!model.byId.has(e.from) || !model.byId.has(e.to)) continue;
    const from = visibleAncestor(model, e.from, expanded);
    const to = visibleAncestor(model, e.to, expanded);
    if (from === to) continue;
    if (ancestors(model, from).includes(to) || ancestors(model, to).includes(from)) continue;
    const key = `${from}\u0000${to}`;
    const lifted = from !== e.from || to !== e.to;
    const cur = merged.get(key);
    if (cur) {
      cur.edges.push(e);
      cur.lifted ||= lifted;
      if (KIND_RANK[e.kind] < KIND_RANK[cur.kind]) cur.kind = e.kind;
    } else {
      merged.set(key, { id: `e${merged.size}`, from, to, kind: e.kind, edges: [e], lifted });
    }
  }
  return [...merged.values()];
}

const PLURAL: Record<NodeKind, string> = {
  module: 'modules',
  file: 'files',
  function: 'functions',
  class: 'classes',
  type: 'types',
  external: 'externals',
};

export function kindCount(kind: NodeKind, n: number): string {
  return `${n} ${n === 1 ? kind : PLURAL[kind]}`;
}

/** "3 functions" or "2 functions, 1 class". */
export function describeChildren(model: Model, id: string): string {
  const counts = new Map<NodeKind, number>();
  for (const c of childrenOf(model, id)) counts.set(c.kind, (counts.get(c.kind) ?? 0) + 1);
  return [...counts].map(([k, n]) => kindCount(k, n)).join(', ');
}

export const CHANGE_WORD: Record<GraphNode['change'], string> = {
  added: 'added',
  modified: 'modified',
  removed: 'removed',
  context: 'unchanged',
};

/** Spoken description of a node, used for aria-label and tooltips. */
export function describeNode(model: Model, node: GraphNode, opts: { visited: boolean }): string {
  const parts: string[] = [node.label];
  if (node.kind === 'external') {
    parts.push('outside this repo');
    const uses = model.graph.edges.filter((e) => e.from === node.id).length;
    if (uses) parts.push(`uses ${uses} symbol${uses === 1 ? '' : 's'} changed here`);
  } else {
    parts.push(node.kind, CHANGE_WORD[node.change]);
    const risk = model.risk.get(node.id);
    if (risk) parts.push(`${risk.band} risk`);
    if (hasChildren(model, node.id)) parts.push(describeChildren(model, node.id));
    const ext = model.externalsOf.get(node.id)?.size ?? 0;
    if (ext) parts.push(`${ext} consumer${ext === 1 ? '' : 's'} outside this repo`);
  }
  if (opts.visited) parts.push('visited');
  return parts.join(', ');
}

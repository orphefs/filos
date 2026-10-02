// Graph layout with ELK (layered, left to right). Expanded nodes become compound nodes with their
// children inside; INCLUDE_CHILDREN lets edges cross container borders. The bundled build runs
// ELK in-thread (no worker, no eval), so it works under the webview's strict CSP.

import ELK from 'elkjs/lib/elk.bundled.js';
import type { ElkExtendedEdge, ElkNode } from 'elkjs/lib/elk-api';

export interface LayoutNodeInput {
  id: string;
  /** Visible parent (a container), if any. */
  parent?: string;
  width: number;
  height: number;
  /** Shown as a container: ELK sizes it around its children; the size above is its minimum. */
  container: boolean;
  /** Space reserved at the top of a container for its header. */
  headerHeight?: number;
}

export interface LayoutEdgeInput {
  id: string;
  from: string;
  to: string;
  label?: { text: string; width: number; height: number };
}

export interface Point {
  x: number;
  y: number;
}

export interface Box extends Point {
  width: number;
  height: number;
}

export interface EdgeRoute {
  points: Point[];
  label?: Box;
}

export type Direction = 'RIGHT' | 'DOWN';

export interface Layout {
  direction: Direction;
  /** Absolute boxes. */
  nodes: Map<string, Box>;
  edges: Map<string, EdgeRoute>;
  width: number;
  height: number;
}

const elk = new ELK();

const ROOT_OPTIONS: Record<string, string> = {
  'elk.algorithm': 'layered',
  'elk.direction': 'RIGHT',
  'elk.hierarchyHandling': 'INCLUDE_CHILDREN',
  'elk.edgeRouting': 'ORTHOGONAL',
  'elk.spacing.nodeNode': '28',
  'elk.layered.spacing.nodeNodeBetweenLayers': '64',
  'elk.spacing.edgeNode': '18',
  'elk.spacing.edgeEdge': '12',
  'elk.layered.spacing.edgeNodeBetweenLayers': '20',
  'elk.spacing.edgeLabel': '4',
  'elk.edgeLabels.placement': 'CENTER',
  'elk.layered.edgeLabels.sideSelection': 'ALWAYS_UP',
  'elk.layered.nodePlacement.strategy': 'NETWORK_SIMPLEX',
  // Keep graph order where possible, so the picture doesn't reshuffle on every expand.
  'elk.layered.considerModelOrder.strategy': 'NODES_AND_EDGES',
  'elk.layered.crossingMinimization.forceNodeModelOrder': 'false',
  'elk.padding': '[top=16,left=16,bottom=16,right=16]',
  // Edge points come back in root coordinates, whichever container an edge lives in.
  'elk.json.edgeCoords': 'ROOT',
};

export async function layoutGraph(nodes: LayoutNodeInput[], edges: LayoutEdgeInput[], direction: Direction = 'RIGHT'): Promise<Layout> {
  const elkById = new Map<string, ElkNode>();
  const parentOf = new Map<string, string | undefined>();
  const root: ElkNode = { id: '__root', layoutOptions: { ...ROOT_OPTIONS, 'elk.direction': direction }, children: [], edges: [] };

  for (const n of nodes) {
    const e: ElkNode = { id: n.id, width: n.width, height: n.height };
    if (n.container) {
      e.children = [];
      e.edges = [];
      e.layoutOptions = {
        'elk.padding': `[top=${n.headerHeight ?? 40},left=14,bottom=14,right=14]`,
        'elk.nodeSize.constraints': 'MINIMUM_SIZE',
        'elk.nodeSize.minimum': `(${n.width},${n.height})`,
      };
    }
    elkById.set(n.id, e);
    parentOf.set(n.id, n.parent);
  }
  for (const n of nodes) {
    const parent = n.parent ? elkById.get(n.parent) : undefined;
    (parent?.children ?? root.children!).push(elkById.get(n.id)!);
  }

  // ELK wants each edge in the lowest common ancestor of its ends.
  const chain = (id: string): string[] => {
    const out: string[] = [];
    for (let p = parentOf.get(id); p; p = parentOf.get(p)) out.push(p);
    return out;
  };
  for (const e of edges) {
    if (!elkById.has(e.from) || !elkById.has(e.to)) continue;
    const up = new Set(chain(e.from));
    const lca = chain(e.to).find((p) => up.has(p));
    const container = (lca && elkById.get(lca)) || root;
    const elkEdge: ElkExtendedEdge = { id: e.id, sources: [e.from], targets: [e.to] };
    if (e.label) elkEdge.labels = [{ text: e.label.text, width: e.label.width, height: e.label.height }];
    container.edges!.push(elkEdge);
  }

  const out = await elk.layout(root);

  const boxes = new Map<string, Box>();
  const routes = new Map<string, EdgeRoute>();
  const walk = (n: ElkNode, ox: number, oy: number) => {
    for (const c of n.children ?? []) {
      const x = ox + (c.x ?? 0);
      const y = oy + (c.y ?? 0);
      boxes.set(c.id, { x, y, width: c.width ?? 0, height: c.height ?? 0 });
      walk(c, x, y);
    }
    for (const e of n.edges ?? []) {
      const s = e.sections?.[0];
      if (!s) continue;
      const points = [s.startPoint, ...(s.bendPoints ?? []), s.endPoint].map((p) => ({ x: p.x, y: p.y }));
      // With edgeCoords=ROOT, edge labels are in root coordinates as well.
      const l = e.labels?.[0];
      routes.set(e.id, { points, label: l ? { x: l.x ?? 0, y: l.y ?? 0, width: l.width ?? 0, height: l.height ?? 0 } : undefined });
    }
  };
  walk(out, 0, 0);
  return { direction, nodes: boxes, edges: routes, width: out.width ?? 0, height: out.height ?? 0 };
}

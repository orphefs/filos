// One review: which repo and range it covers, the validated graph, the view state the webview
// reports, and what the webview should show if it (re)loads. Small on purpose: no event log.

import { join, normalize } from 'node:path';
import * as vscode from 'vscode';
import type { Anchor, FileOutline, GraphNode, ReviewGraph } from '../contract/graph';
import { scoreGraph, type RiskScore } from '../contract/risk';
import type { ErrorAction, GraphSource, HostToWebview, ViewState } from '../protocol';

export interface ReviewTarget {
  kind: 'sample' | 'branch';
  /** Absolute, real path of the repo with the head revision checked out. Files open from here. */
  repoRoot: string;
  base: string;
  head: string;
  prTitle: string;
}

export type SessionStatus =
  | { kind: 'loading'; message: string; detail?: string }
  | { kind: 'loaded' }
  | { kind: 'error'; message: string; detail?: string; actions: ErrorAction[] };

/** What the webview last said it rendered (kept for tests and for "what can the user see"). */
export interface RenderedInfo {
  visibleNodes: string[];
  expanded: string[];
  selected?: string;
  at: number;
}

const EMPTY_STATE: ViewState = { expanded: [], visited: [] };

/** Case-insensitive file systems need case-insensitive lookups. */
export function fileKey(fsPath: string): string {
  const p = normalize(fsPath);
  return process.platform === 'win32' || process.platform === 'darwin' ? p.toLowerCase() : p;
}

export class ReviewSession {
  graph?: ReviewGraph;
  source?: GraphSource;
  warnings: string[] = [];
  scores = new Map<string, RiskScore>();
  status: SessionStatus = { kind: 'loading', message: 'Preparing the review…' };
  state: ViewState;
  lastRendered?: RenderedInfo;

  private nodes = new Map<string, GraphNode>();
  private children = new Map<string, GraphNode[]>();
  private outlines = new Map<string, FileOutline>();

  constructor(
    readonly target: ReviewTarget,
    private readonly store: vscode.Memento,
  ) {
    this.state = store.get<ViewState>(this.storeKey) ?? EMPTY_STATE;
  }

  /** Identifies the PR: same repo and range means the same review, so view state carries over. */
  get key(): string {
    return `${this.target.repoRoot}\u0000${this.target.base}...${this.target.head}`;
  }

  private get storeKey(): string {
    return `filos.viewState:${this.key}`;
  }

  setLoading(message: string, detail?: string): void {
    this.status = { kind: 'loading', message, detail };
  }

  setError(message: string, actions: ErrorAction[], detail?: string): void {
    this.status = { kind: 'error', message, detail, actions };
  }

  load(graph: ReviewGraph, source: GraphSource, warnings: string[]): void {
    this.graph = graph;
    this.source = source;
    this.warnings = warnings;
    this.scores = scoreGraph(graph);
    this.nodes = new Map(graph.nodes.map((n) => [n.id, n] as const));
    this.children = new Map();
    for (const n of graph.nodes) {
      if (!n.parent) continue;
      const list = this.children.get(n.parent) ?? [];
      list.push(n);
      this.children.set(n.parent, list);
    }
    this.outlines = new Map(graph.files.map((f) => [fileKey(this.absPath(f.path)), f] as const));
    // A re-run may rename or drop nodes; keep only what still exists.
    const known = (id: string) => this.nodes.has(id);
    this.state = {
      expanded: this.state.expanded.filter(known),
      visited: this.state.visited.filter(known),
      selected: this.state.selected && known(this.state.selected) ? this.state.selected : undefined,
    };
    this.status = { kind: 'loaded' };
  }

  /**
   * A re-run of the same PR: keep the previous run's outlines until the new graph arrives, so the
   * files already open keep their folds and gists while the agent works.
   */
  inheritOutlines(previous: ReviewSession): void {
    if (previous.key === this.key && !this.graph) this.outlines = previous.outlines;
  }

  saveState(state: ViewState): Thenable<void> {
    this.state = state;
    return this.store.update(this.storeKey, state);
  }

  /** The message that brings a freshly (re)loaded webview up to date. */
  snapshot(): HostToWebview {
    const s = this.status;
    if (s.kind === 'loading') return { type: 'loading', message: s.message, detail: s.detail };
    if (s.kind === 'error') return { type: 'error', message: s.message, detail: s.detail, actions: s.actions };
    return { type: 'load', graph: this.graph!, source: this.source!, state: this.state, warnings: this.warnings };
  }

  node(id: string): GraphNode | undefined {
    return this.nodes.get(id);
  }

  /** The node's own anchors; for a node without any (e.g. a module), the union of its descendants'. */
  anchorsFor(node: GraphNode): Anchor[] {
    if (node.kind === 'external') return [];
    if (node.anchors.length) return node.anchors;
    const out: Anchor[] = [];
    const seen = new Set<string>();
    const walk = (n: GraphNode) => {
      for (const c of this.children.get(n.id) ?? []) {
        for (const a of c.anchors) {
          const k = `${a.file}:${a.startLine}-${a.endLine}`;
          if (!seen.has(k)) {
            seen.add(k);
            out.push(a);
          }
        }
        walk(c);
      }
    };
    walk(node);
    return out;
  }

  absPath(relPath: string): string {
    return join(this.target.repoRoot, ...relPath.split('/'));
  }

  uriFor(relPath: string): vscode.Uri {
    return vscode.Uri.file(this.absPath(relPath));
  }

  outlineFor(uri: vscode.Uri): FileOutline | undefined {
    return uri.scheme === 'file' ? this.outlines.get(fileKey(uri.fsPath)) : undefined;
  }
}

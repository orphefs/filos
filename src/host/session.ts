// One review: which repo and range it covers, the validated graph, the view state the webview
// reports, and what the webview should show if it (re)loads. Small on purpose: no event log.

import { join, normalize } from 'node:path';
import * as vscode from 'vscode';
import type { Anchor, FileOutline, GraphNode, ReviewGraph } from '../contract/graph';
import { scoreGraph, type RiskScore } from '../contract/risk';
import type { ErrorAction, GraphSource, HostToWebview, LoadingStep, ViewState } from '../protocol';
import { mergePostedMarks, parsePersistedReview, type PersistedReview } from '../review/model';
import type { PullRequestLookup } from './github';

export interface ReviewTarget {
  /** sample: the bundled example; branch: the workspace's branch; pr: a GitHub pull request in Filos's own checkout. */
  kind: 'sample' | 'branch' | 'pr';
  /** Absolute, real path of the repo with the head revision checked out. Files open from here. */
  repoRoot: string;
  base: string;
  head: string;
  prTitle: string;
  /** Pull request reviews: which one. Its URL keys the stored review, whatever commit is checked out. */
  pr?: { url: string; host: string; owner: string; repo: string; number: number };
}

export type SessionStatus =
  | { kind: 'loading'; message: string; detail?: string; steps?: LoadingStep[] }
  | { kind: 'loaded' }
  | { kind: 'error'; message: string; detail?: string; actions: ErrorAction[]; steps?: LoadingStep[] };

/** What the webview last said it rendered (kept for tests and for "what can the user see"). */
export interface RenderedInfo {
  visibleNodes: string[];
  expanded: string[];
  selected?: string;
  at: number;
}

const EMPTY_STATE: ViewState = { expanded: [], visited: [] };

/**
 * How a review's files are addressed in the editor: file: URIs for the sample and the workspace's
 * branch; filos-pr: (prFiles.ts, read-only) for a pull request's checkout, so other extensions
 * never take it for an on-disk project.
 */
export interface CodeLocation {
  /** The URI for an absolute path in the repo, or undefined when it can't be served. */
  uri(absPath: string): vscode.Uri | undefined;
  /** The absolute path a URI stands for, or undefined for URIs of another kind. */
  path(uri: vscode.Uri): string | undefined;
}

export const FILE_LOCATION: CodeLocation = {
  uri: (p) => vscode.Uri.file(p),
  path: (u) => (u.scheme === 'file' ? u.fsPath : undefined),
};

/** The keys a review is stored under (view state, and answers/comments/progress). */
export function storedKeys(key: string): string[] {
  return [`filos.viewState:${key}`, `filos.review:${key}`];
}

/**
 * Moves what was stored for review `key` from `from` to `to`, unless `to` has it already. Pull
 * request reviews were kept per workspace; they are global now, since the same PR can be opened
 * from any window (or none).
 */
export function migrateStored(key: string, from: vscode.Memento, to: vscode.Memento): void {
  for (const k of storedKeys(key)) {
    const old = from.get<unknown>(k);
    if (old === undefined) continue;
    if (to.get<unknown>(k) === undefined) void to.update(k, old);
    void from.update(k, undefined);
  }
}

/**
 * The entry for a file in a map keyed by normalised absolute paths: by its exact path, else, where
 * file systems are usually case-insensitive (macOS, Windows), by the same path in another case (a
 * drive letter VS Code lower-cased, an editor opened through a differently cased path). Exact
 * first, because macOS volumes can be case-sensitive too: there Foo.ts and foo.ts are two files.
 */
export function entryForPath<T>(map: ReadonlyMap<string, T>, fsPath: string, platform: NodeJS.Platform = process.platform): T | undefined {
  const p = normalize(fsPath);
  const exact = map.get(p);
  if (exact !== undefined || (platform !== 'win32' && platform !== 'darwin')) return exact;
  const lower = p.toLowerCase();
  for (const [k, v] of map) if (k.toLowerCase() === lower) return v;
  return undefined;
}

export class ReviewSession {
  graph?: ReviewGraph;
  source?: GraphSource;
  warnings: string[] = [];
  scores = new Map<string, RiskScore>();
  status: SessionStatus = { kind: 'loading', message: 'Preparing the review…' };
  state: ViewState;
  lastRendered?: RenderedInfo;
  /** The PR diff base...head, when one was computed (agent runs); posting needs its head lines. */
  diff?: string;
  /**
   * Branch reviews: the commit reviewed, resolved once when the diff was computed (the diff is
   * base...this). Comments' lines refer to it, whatever is checked out when they're posted.
   */
  headOid?: string;
  dependencyIndex?: string;
  /** Key of the private confidence store: "sample:@acme/ledger", the normalised origin, or the repo root. */
  repoKey: string;
  /** Branch reviews: the pull request lookup, started with the session (gh is slow). */
  pullRequest?: Promise<PullRequestLookup>;
  /** Pull request reviews: the pull request, already looked up (it is where the review was started from). */
  knownPullRequest?: PullRequestLookup;

  private nodes = new Map<string, GraphNode>();
  private children = new Map<string, GraphNode[]>();
  private outlines = new Map<string, FileOutline>();

  constructor(
    readonly target: ReviewTarget,
    private readonly store: vscode.Memento,
    repoKey?: string,
    private readonly code: CodeLocation = FILE_LOCATION,
  ) {
    this.state = store.get<ViewState>(this.storeKey) ?? EMPTY_STATE;
    this.repoKey = repoKey ?? target.repoRoot;
  }

  /**
   * Identifies the PR: same repo and range means the same review, so view state carries over. A
   * pull request is itself, by URL, at any commit: a re-run after the author pushed keeps the answers
   * and comments (comments on the earlier commit are posted in the review body, see planPost).
   */
  get key(): string {
    return ReviewSession.keyFor(this.target);
  }

  static keyFor(target: ReviewTarget): string {
    if (target.kind === 'pr' && target.pr) return `pr\u0000${target.pr.url.toLowerCase()}`;
    return `${target.repoRoot}\u0000${target.base}...${target.head}`;
  }

  private get storeKey(): string {
    return `filos.viewState:${this.key}`;
  }

  /** Questionnaire answers, comments and didactic progress: per PR, beside the view state. */
  private get reviewKey(): string {
    return `filos.review:${this.key}`;
  }

  /** Raw stored review state; ReviewModel validates it. */
  loadReview(): unknown {
    return this.store.get<unknown>(this.reviewKey);
  }

  /** Stores the review. Posted marks already stored for the same comments are kept (they only grow). */
  saveReview(review: PersistedReview): Thenable<void> {
    return this.store.update(this.reviewKey, mergePostedMarks(review, this.store.get<unknown>(this.reviewKey)));
  }

  /**
   * For a review that was closed or re-run while its post ran: a newer review of this PR may own the
   * stored state now, so only the posted marks are added to it. Stores `review` if nothing is stored.
   */
  savePostedMarks(review: PersistedReview): Thenable<void> {
    const current = parsePersistedReview(this.store.get<unknown>(this.reviewKey));
    return this.store.update(this.reviewKey, current ? mergePostedMarks(current, review) : review);
  }

  setLoading(message: string, detail?: string, steps?: LoadingStep[]): void {
    this.status = { kind: 'loading', message, detail, ...(steps ? { steps } : {}) };
  }

  setError(message: string, actions: ErrorAction[], detail?: string, steps?: LoadingStep[]): void {
    this.status = { kind: 'error', message, detail, actions, ...(steps ? { steps } : {}) };
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
    this.outlines = new Map(graph.files.map((f) => [normalize(this.absPath(f.path)), f] as const));
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
    if (s.kind === 'loading') return { type: 'loading', message: s.message, detail: s.detail, ...(s.steps ? { steps: s.steps } : {}) };
    if (s.kind === 'error') return { type: 'error', message: s.message, detail: s.detail, actions: s.actions, ...(s.steps ? { steps: s.steps } : {}) };
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

  /** The editor URI for a repo-relative path (filos-pr: for a pull request), or undefined when it can't be served. */
  uriFor(relPath: string): vscode.Uri | undefined {
    return this.code.uri(this.absPath(relPath));
  }

  outlineFor(uri: vscode.Uri): FileOutline | undefined {
    const p = this.code.path(uri);
    return p === undefined ? undefined : entryForPath(this.outlines, p);
  }
}

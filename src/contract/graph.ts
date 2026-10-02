// The review-graph contract (v0.1): what the comprehension pass must return.
// Mirrors schema/review-graph.schema.json; docs/graph-contract.md explains the intent.
// Shared by the extension host and the webview, so keep it free of node/vscode imports.

export const CONTRACT_VERSION = '0.1';

export interface ReviewGraph {
  contractVersion: typeof CONTRACT_VERSION;
  pr: PrInfo;
  /** 1–3 sentences shown above the graph: what the PR touches and where the risk is. */
  orientation: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
  /** One outline per touched file: the foldable regions and their one-line gists. */
  files: FileOutline[];
  generatedBy?: { provider: string; model?: string; at?: string };
}

export interface PrInfo {
  title: string;
  base: string;
  head: string;
  author?: string;
  url?: string;
}

/**
 * module   — a directory or package-level grouping; always top level.
 * file     — a single source file (child of a module).
 * function / class / type — a symbol (child of a module or file).
 * external — a consumer outside this repo (top level, no anchors).
 */
export type NodeKind = 'module' | 'file' | 'function' | 'class' | 'type' | 'external';

/** context = unchanged code that matters for understanding the change. */
export type ChangeKind = 'added' | 'modified' | 'removed' | 'context';

export interface GraphNode {
  /** Unique and stable across re-runs where possible, e.g. "money", "money/roundToCents". */
  id: string;
  label: string;
  kind: NodeKind;
  /** Containing node id. Absent for modules and externals. */
  parent?: string;
  change: ChangeKind;
  risk: Risk;
  /** 2–4 sentences for the summary pane: what changed and why it matters. */
  summary: string;
  /** Code regions this node is about (head revision). Empty for externals. */
  anchors: Anchor[];
}

/** 1-based, inclusive line numbers in the head revision. */
export interface Anchor {
  file: string; // repo-relative, forward slashes
  startLine: number;
  endLine: number;
  /** Symbol name, if the anchor is a declaration. Used to re-resolve lines if they drift. */
  symbol?: string;
}

/**
 * Countable signals. The risk colour is computed from these (src/contract/risk.ts),
 * with the agent's own judgement as one damped input, never the whole story.
 */
export interface RiskSignals {
  /** Consumers outside this repo (from the dependency index, or the agent's search). */
  externalConsumers?: number;
  /** In-repo call sites / importers of this symbol. */
  internalFanOut?: number;
  /** Exported from the package's public entry point. */
  publicApi?: boolean;
  /** Existing tests exercise this code. */
  hasTests?: boolean;
  /** Tests covering this code were changed in this PR. */
  testsChanged?: boolean;
  /** Lines added + removed for this node in the diff. */
  linesChanged?: number;
  /** Behaviour visible to callers changes (not just a refactor). */
  behaviourChange?: boolean;
}

export interface Risk {
  signals: RiskSignals;
  /** The agent's own 0..1 estimate. Damped when combined with the signals. */
  judgement?: number;
  /** One sentence: why this is (or isn't) risky. */
  why: string;
}

export type EdgeKind = 'calls' | 'imports' | 'affects' | 'consumes' | 'tests';

/** Direction is always "from depends on / acts on to": a caller calls a callee, an external consumes a symbol. */
export interface GraphEdge {
  from: string;
  to: string;
  kind: EdgeKind;
  label?: string;
}

export interface FileOutline {
  path: string;
  regions: Region[];
}

/** A foldable region (typically a top-level declaration) with a one-line gist shown when folded. */
export interface Region {
  startLine: number;
  endLine: number;
  symbol?: string;
  gist: string;
}

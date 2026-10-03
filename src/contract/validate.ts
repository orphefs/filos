// Validates untrusted graph JSON: schema first (ajv), then semantic checks the schema can't express.
// Never trust a provider to honour the contract.

import Ajv from 'ajv';
import schema from '../../schema/review-graph.schema.json';
import type { GraphEdge, GraphNode, ReviewGraph } from './graph';

export type ValidationResult =
  | { ok: true; graph: ReviewGraph; warnings: string[] }
  | { ok: false; errors: string[]; warnings: string[] };

export interface ValidateOptions {
  /** Returns the head-revision text of a repo-relative file, or undefined if missing. Enables line-bound checks. */
  readFile?: (path: string) => string | undefined;
  /**
   * Repair line-number slips instead of rejecting: clamp ranges to the file, trim or drop
   * partially overlapping outline regions, drop ranges in missing files or outside the repo,
   * flip reversed 'consumes' edges. Each repair becomes a warning. Structural problems (ids,
   * parents, unknown edge ends) are still errors, and so is a repair that leaves no code at all.
   * Use for agent output; hand-written fixtures stay strict.
   */
  repair?: boolean;
  /** Absolute repo root. In repair mode, absolute paths under it are made repo-relative. */
  repoRoot?: string;
}

const ajv = new Ajv({ allErrors: true, strict: false });
const schemaCheck = ajv.compile(schema);

const PARENT_KINDS = new Set(['module', 'file', 'class']);

/** Returns a copy of the graph with canonical paths (never the input itself), or the errors. */
export function validateGraph(input: unknown, opts: ValidateOptions = {}): ValidationResult {
  const warnings: string[] = [];
  if (!schemaCheck(input)) {
    const errors = (schemaCheck.errors ?? []).map((e) => `${e.instancePath || '(root)'} ${e.message ?? 'is invalid'}${e.params && 'allowedValues' in e.params ? `: ${(e.params as { allowedValues: unknown[] }).allowedValues.join(', ')}` : ''}`);
    return { ok: false, errors, warnings };
  }
  const graph = structuredClone(input) as unknown as ReviewGraph;
  const errors: string[] = [];
  const badPaths = new Set<string>();
  if (opts.repair) {
    const before = codeRefs(graph);
    const firstRepair = warnings.length;
    repairPaths(graph, opts.repoRoot, warnings);
    repairLines(graph, opts.readFile, warnings);
    // Dropping every range "succeeds" into a review with no code; make it a contract failure instead.
    const after = codeRefs(graph);
    const lost = [before.anchors > 0 && after.anchors === 0 && 'anchor', before.outlines > 0 && after.outlines === 0 && 'file outline'].filter(Boolean);
    if (lost.length) {
      const example = warnings.slice(firstRepair).find((w) => w.startsWith('repaired: dropped'));
      errors.push(`the agent's line references could not be matched to the repo: repair dropped every ${lost.join(' and every ')}${example ? ` (e.g. ${example.replace('repaired: ', '')})` : ''}`);
    }
  } else {
    checkPaths(graph, errors, badPaths);
  }

  const byId = new Map<string, GraphNode>();
  for (const n of graph.nodes) {
    if (byId.has(n.id)) errors.push(`duplicate node id "${n.id}"`);
    byId.set(n.id, n);
  }

  for (const n of graph.nodes) {
    if ((n.kind === 'module' || n.kind === 'external') && n.parent) errors.push(`${n.kind} "${n.id}" must not have a parent`);
    if (n.kind !== 'module' && n.kind !== 'external' && !n.parent) errors.push(`${n.kind} "${n.id}" needs a parent`);
    if (n.parent) {
      const p = byId.get(n.parent);
      if (!p) errors.push(`node "${n.id}" has unknown parent "${n.parent}"`);
      else if (!PARENT_KINDS.has(p.kind)) errors.push(`node "${n.id}" has parent "${p.id}" of kind ${p.kind}, which cannot contain nodes`);
    }
    if (n.kind === 'external' && n.anchors.length) warnings.push(`external "${n.id}" has anchors; they are ignored`);
    if (n.kind !== 'external' && n.kind !== 'module' && n.anchors.length === 0) warnings.push(`node "${n.id}" has no anchors, so clicking it shows no code`);
    for (const a of n.anchors) {
      if (a.startLine > a.endLine) errors.push(`node "${n.id}" anchor ${a.file}:${a.startLine}-${a.endLine} ends before it starts`);
    }
  }

  // Parent chains must terminate.
  for (const n of graph.nodes) {
    const seen = new Set<string>();
    let cur: typeof n | undefined = n;
    while (cur?.parent) {
      if (seen.has(cur.id)) {
        errors.push(`parent cycle through "${n.id}"`);
        break;
      }
      seen.add(cur.id);
      cur = byId.get(cur.parent);
    }
  }

  graph.edges = checkEdges(graph.edges, byId, !!opts.repair, errors, warnings);

  const outlinePaths = new Set<string>();
  for (const f of graph.files) {
    if (outlinePaths.has(f.path)) errors.push(`duplicate file outline "${f.path}"`);
    outlinePaths.add(f.path);
    for (const r of f.regions) {
      if (r.startLine > r.endLine) errors.push(`${f.path} region ${r.startLine}-${r.endLine} ends before it starts`);
    }
    errors.push(...overlapErrors(f.path, f.regions));
  }
  for (const n of graph.nodes) {
    for (const a of n.anchors) {
      if (!outlinePaths.has(a.file) && !badPaths.has(a.file)) warnings.push(`anchor file "${a.file}" (node "${n.id}") has no outline, so it won't get folds or gists`);
    }
  }

  if (opts.readFile) {
    const lineCounts = new Map<string, number | undefined>();
    const lines = (path: string) => {
      if (!lineCounts.has(path)) {
        const text = opts.readFile!(path);
        lineCounts.set(path, text === undefined ? undefined : text.replace(/\n$/, '').split('\n').length);
      }
      return lineCounts.get(path);
    };
    const check = (where: string, path: string, start: number, end: number) => {
      if (badPaths.has(path)) return; // already an error; don't read outside the repo
      const count = lines(path);
      if (count === undefined) errors.push(`${where}: file "${path}" not found in head revision`);
      else if (end > count) errors.push(`${where}: lines ${start}-${end} exceed ${path} (${count} lines)`);
    };
    for (const n of graph.nodes) for (const a of n.anchors) check(`node "${n.id}"`, a.file, a.startLine, a.endLine);
    for (const f of graph.files) for (const r of f.regions) check(`outline region "${r.symbol ?? r.gist}"`, f.path, r.startLine, r.endLine);
  }

  return errors.length ? { ok: false, errors, warnings } : { ok: true, graph, warnings };
}

/**
 * Repo-relative, '/'-separated form of a path: backslashes become '/', and empty and '.' segments
 * go. Undefined if it has a '..' segment, names no file, or is absolute and not under `root`.
 */
export function canonicalPath(raw: string, root?: string): string | undefined {
  const parts = segments(raw);
  if (!parts) return undefined;
  if (!isAbsolutePath(raw)) return parts.length ? parts.join('/') : undefined;
  const rootParts = root !== undefined && isAbsolutePath(root) ? segments(root) : undefined;
  if (!rootParts || parts.length <= rootParts.length || !rootParts.every((s, i) => s === parts[i])) return undefined;
  return parts.slice(rootParts.length).join('/');
}

/** Path segments with drive letters lower-cased, or undefined if any segment is '..'. */
function segments(p: string): string[] | undefined {
  const parts = p.replace(/\\/g, '/').split('/').filter((s) => s !== '' && s !== '.');
  if (parts.includes('..')) return undefined;
  return parts.map((s, i) => (i === 0 && /^[A-Za-z]:$/.test(s) ? s.toLowerCase() : s));
}

function isAbsolutePath(p: string): boolean {
  return /^([\\/]|[A-Za-z]:([\\/]|$))/.test(p);
}

/** Strict mode: canonicalise harmless spellings ('./a', 'a\\b'), reject paths that leave the repo. */
function checkPaths(graph: ReviewGraph, errors: string[], badPaths: Set<string>): void {
  const fix = (where: string, raw: string): string => {
    const p = canonicalPath(raw);
    if (p !== undefined) return p;
    errors.push(`${where} path "${raw}" must be repo-relative, without ".." segments`);
    badPaths.add(raw);
    return raw;
  };
  for (const n of graph.nodes) for (const a of n.anchors) a.file = fix(`node "${n.id}" anchor`, a.file);
  for (const f of graph.files) f.path = fix('file outline', f.path);
}

/** Repair mode: also rebase absolute paths under the repo root; drop whatever still points outside it. */
function repairPaths(graph: ReviewGraph, repoRoot: string | undefined, warnings: string[]): void {
  const rebased = new Set<string>();
  const fix = (raw: string): string | undefined => {
    const p = canonicalPath(raw, repoRoot);
    if (p !== undefined && isAbsolutePath(raw) && !rebased.has(raw)) {
      rebased.add(raw);
      warnings.push(`repaired: made absolute path "${raw}" repo-relative ("${p}")`);
    }
    return p;
  };
  for (const n of graph.nodes) {
    n.anchors = n.anchors.flatMap((a) => {
      const file = fix(a.file);
      if (file === undefined) warnings.push(`repaired: dropped an anchor of "${n.id}", path "${a.file}" is not inside the repo`);
      return file === undefined ? [] : [{ ...a, file }];
    });
  }
  graph.files = graph.files.flatMap((f) => {
    const path = fix(f.path);
    if (path === undefined) warnings.push(`repaired: dropped the outline of "${f.path}", which is not inside the repo`);
    return path === undefined ? [] : [{ ...f, path }];
  });
}

/** What a review needs to show any code: anchors on in-repo nodes, and file outlines. */
function codeRefs(graph: ReviewGraph): { anchors: number; outlines: number } {
  const anchors = graph.nodes.reduce((sum, n) => sum + (n.kind === 'external' ? 0 : n.anchors.length), 0);
  return { anchors, outlines: graph.files.length };
}

/**
 * Edge ends must exist. Externals only consume ('ext/* -> symbol'): nothing points at an external,
 * and only an external is the source of 'consumes'. Exact duplicates are dropped in both modes.
 */
function checkEdges(edges: GraphEdge[], byId: Map<string, GraphNode>, repair: boolean, errors: string[], warnings: string[]): GraphEdge[] {
  const seen = new Set<string>();
  return edges.flatMap((e) => {
    const from = byId.get(e.from);
    const to = byId.get(e.to);
    if (!from) errors.push(`edge ${e.from} -> ${e.to} has unknown source`);
    if (!to) errors.push(`edge ${e.from} -> ${e.to} has unknown target`);
    if (!from || !to) return [e];
    if (e.from === e.to) warnings.push(`self-edge on "${e.from}" ignored`);

    let edge = e;
    const fromExt = from.kind === 'external';
    const toExt = to.kind === 'external';
    const reversed = e.kind === 'consumes' && !fromExt && toExt;
    const problem = reversed
      ? `is reversed: an external consumes a symbol, so it should run ${e.to} -> ${e.from}`
      : toExt
        ? `points at external "${e.to}"; externals consume, they are not consumed`
        : e.kind === 'consumes' && !fromExt
          ? `is 'consumes' but "${e.from}" is not an external; only externals consume`
          : undefined;
    if (problem) {
      if (!repair) {
        errors.push(`edge ${e.from} -> ${e.to} (${e.kind}) ${problem}`);
        return [e];
      }
      if (!reversed) {
        warnings.push(`repaired: dropped edge ${e.from} -> ${e.to} (${e.kind}), which ${problem}`);
        return [];
      }
      warnings.push(`repaired: flipped edge ${e.from} -> ${e.to} (consumes) to ${e.to} -> ${e.from}`);
      edge = { ...e, from: e.to, to: e.from };
    }

    const key = JSON.stringify([edge.from, edge.to, edge.kind]);
    if (seen.has(key)) {
      warnings.push(`dropped duplicate edge ${edge.from} -> ${edge.to} (${edge.kind})`);
      return [];
    }
    seen.add(key);
    return [edge];
  });
}

/**
 * Regions may nest (class > method) but must not partially overlap. Sorted outer-first, each region
 * must sit inside the innermost still-open region, so a stack catches non-adjacent overlaps too.
 */
function overlapErrors(path: string, regions: { startLine: number; endLine: number }[]): string[] {
  const errors: string[] = [];
  const sorted = regions.filter((r) => r.startLine <= r.endLine).sort((a, b) => a.startLine - b.startLine || b.endLine - a.endLine);
  const open: typeof sorted = [];
  for (const r of sorted) {
    while (open.length && open[open.length - 1].endLine < r.startLine) open.pop();
    const top = open[open.length - 1];
    if (top && r.endLine > top.endLine) errors.push(`${path} regions ${top.startLine}-${top.endLine} and ${r.startLine}-${r.endLine} partially overlap`);
    else open.push(r);
  }
  return errors;
}

/** Fixes the line-number slips agents make, in place, recording a warning per repair. */
function repairLines(graph: ReviewGraph, readFile: ValidateOptions['readFile'], warnings: string[]): void {
  const counts = new Map<string, number | undefined>();
  const lineCount = (path: string): number | undefined => {
    if (!readFile) return Number.POSITIVE_INFINITY;
    if (!counts.has(path)) {
      const text = readFile(path);
      counts.set(path, text === undefined ? undefined : text.replace(/\n$/, '').split('\n').length);
    }
    return counts.get(path);
  };
  /** Returns the clamped range, or undefined if nothing of it is left. */
  const clamp = (where: string, path: string, start: number, end: number): [number, number] | undefined => {
    const count = lineCount(path);
    if (count === undefined) {
      warnings.push(`repaired: dropped ${where}, file "${path}" is not in the head revision`);
      return undefined;
    }
    if (start > end) {
      warnings.push(`repaired: swapped ${where} ${path}:${start}-${end}, which ended before it started, to ${end}-${start}`);
      [start, end] = [end, start];
    }
    if (start > count) {
      warnings.push(`repaired: dropped ${where} at ${path}:${start}-${end}, past the end of the file (${count} lines)`);
      return undefined;
    }
    if (end > count) {
      warnings.push(`repaired: clamped ${where} ${path}:${start}-${end} to end at line ${count}`);
      end = count;
    }
    return [start, end];
  };

  for (const n of graph.nodes) {
    n.anchors = n.anchors.flatMap((a) => {
      const r = clamp(`an anchor of "${n.id}"`, a.file, a.startLine, a.endLine);
      return r ? [{ ...a, startLine: r[0], endLine: r[1] }] : [];
    });
  }

  graph.files = graph.files.filter((f) => {
    if (lineCount(f.path) !== undefined) return true;
    warnings.push(`repaired: dropped the outline of "${f.path}", which is not in the head revision`);
    return false;
  });
  for (const f of graph.files) {
    const regions = f.regions
      .flatMap((r) => {
        const c = clamp(`outline region "${r.symbol ?? r.gist}"`, f.path, r.startLine, r.endLine);
        return c ? [{ ...r, startLine: c[0], endLine: c[1] }] : [];
      })
      .sort((a, b) => a.startLine - b.startLine || b.endLine - a.endLine);
    const kept: typeof regions = [];
    for (const r of regions) {
      let keep = true;
      // Partial overlap with an earlier region (nesting is fine). Usually a doc comment or closing
      // brace counted twice, so end the earlier region just before r, unless that breaks its nesting.
      for (let clash = findClash(kept, r); clash && keep; clash = findClash(kept, r)) {
        const c = clash;
        const trimmedEnd = r.startLine - 1;
        const breaksNesting = kept.some((k) => k !== c && k.startLine >= c.startLine && k.endLine <= c.endLine && k.endLine > trimmedEnd);
        if (trimmedEnd >= c.startLine && !breaksNesting) {
          warnings.push(`repaired: ${f.path} regions ${c.startLine}-${c.endLine} and ${r.startLine}-${r.endLine} overlapped; the first now ends at ${trimmedEnd}`);
          c.endLine = trimmedEnd;
        } else {
          warnings.push(`repaired: dropped ${f.path} region ${r.startLine}-${r.endLine}, which overlapped ${c.startLine}-${c.endLine}`);
          keep = false;
        }
      }
      if (keep) kept.push(r);
    }
    f.regions = kept;
  }
}

function findClash<T extends { startLine: number; endLine: number }>(kept: T[], r: T): T | undefined {
  return kept.find((k) => k.startLine < r.startLine && r.startLine <= k.endLine && r.endLine > k.endLine);
}

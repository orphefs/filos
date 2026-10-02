// Validates untrusted graph JSON: schema first (ajv), then semantic checks the schema can't express.
// Never trust a provider to honour the contract.

import Ajv from 'ajv';
import schema from '../../schema/review-graph.schema.json';
import type { ReviewGraph } from './graph';

export type ValidationResult =
  | { ok: true; graph: ReviewGraph; warnings: string[] }
  | { ok: false; errors: string[]; warnings: string[] };

export interface ValidateOptions {
  /** Returns the head-revision text of a repo-relative file, or undefined if missing. Enables line-bound checks. */
  readFile?: (path: string) => string | undefined;
}

const ajv = new Ajv({ allErrors: true, strict: false });
const schemaCheck = ajv.compile(schema);

const PARENT_KINDS = new Set(['module', 'file', 'class']);

export function validateGraph(input: unknown, opts: ValidateOptions = {}): ValidationResult {
  const warnings: string[] = [];
  if (!schemaCheck(input)) {
    const errors = (schemaCheck.errors ?? []).map((e) => `${e.instancePath || '(root)'} ${e.message ?? 'is invalid'}${e.params && 'allowedValues' in e.params ? `: ${(e.params as { allowedValues: unknown[] }).allowedValues.join(', ')}` : ''}`);
    return { ok: false, errors, warnings };
  }
  const graph = input as unknown as ReviewGraph;
  const errors: string[] = [];

  const byId = new Map<string, (typeof graph.nodes)[number]>();
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

  for (const e of graph.edges) {
    if (!byId.has(e.from)) errors.push(`edge ${e.from} -> ${e.to} has unknown source`);
    if (!byId.has(e.to)) errors.push(`edge ${e.from} -> ${e.to} has unknown target`);
    if (e.from === e.to) warnings.push(`self-edge on "${e.from}" ignored`);
  }

  const outlinePaths = new Set<string>();
  for (const f of graph.files) {
    if (outlinePaths.has(f.path)) errors.push(`duplicate file outline "${f.path}"`);
    outlinePaths.add(f.path);
    const sorted = [...f.regions].sort((a, b) => a.startLine - b.startLine);
    for (let i = 0; i < sorted.length; i++) {
      const r = sorted[i];
      if (r.startLine > r.endLine) errors.push(`${f.path} region ${r.startLine}-${r.endLine} ends before it starts`);
      const next = sorted[i + 1];
      // Regions may nest (class > method) but must not partially overlap.
      if (next && next.startLine <= r.endLine && next.endLine > r.endLine) {
        errors.push(`${f.path} regions ${r.startLine}-${r.endLine} and ${next.startLine}-${next.endLine} partially overlap`);
      }
    }
  }
  for (const n of graph.nodes) {
    for (const a of n.anchors) {
      if (!outlinePaths.has(a.file)) warnings.push(`anchor file "${a.file}" (node "${n.id}") has no outline, so it won't get folds or gists`);
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
      const count = lines(path);
      if (count === undefined) errors.push(`${where}: file "${path}" not found in head revision`);
      else if (end > count) errors.push(`${where}: lines ${start}-${end} exceed ${path} (${count} lines)`);
    };
    for (const n of graph.nodes) for (const a of n.anchors) check(`node "${n.id}"`, a.file, a.startLine, a.endLine);
    for (const f of graph.files) for (const r of f.regions) check(`outline region "${r.symbol ?? r.gist}"`, f.path, r.startLine, r.endLine);
  }

  return errors.length ? { ok: false, errors, warnings } : { ok: true, graph, warnings };
}

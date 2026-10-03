// Private, local confidence per module: { confidence 0..1, lastTouched }. Nothing else is kept,
// and nothing here leaves the machine. The host backs the store with globalState
// ("filos.confidence.v1": { [repoKey]: { [modulePath]: record } }); tests use MemoryConfidenceStore.

import type { Familiarity } from './types';
import type { GraphIndex } from './order';

export interface ConfidenceRecord {
  /** 0..1 */
  confidence: number;
  /** ISO date of the last change; kept so decay can be added later. */
  lastTouched: string;
}

export interface ConfidenceStore {
  get(modulePath: string): ConfidenceRecord | undefined;
  set(modulePath: string, value: ConfidenceRecord): void;
}

export const CONFIDENCE_STATE_KEY = 'filos.confidence.v1';

/** The whole globalState value: records per repo, per module path. */
export type ConfidenceData = Record<string, Record<string, ConfidenceRecord>>;

/** Starting value from the familiarity answer, used only when there's no stored record. */
export const FAMILIARITY_START: Readonly<Record<Familiarity, number>> = { new: 0.2, some: 0.5, known: 0.8 };

/** How an understand question ended. */
export type UnderstandOutcome = 'firstTry' | 'secondTry' | 'partly' | 'incorrect';

export const CONFIDENCE_DELTA: Readonly<Record<UnderstandOutcome, number>> = { firstTry: 0.15, secondTry: 0.05, partly: 0.05, incorrect: -0.1 };

/** Clamped to 0..1 and rounded to 3 places, so repeated float steps don't accumulate noise. */
export function clampConfidence(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.round(Math.max(0, Math.min(1, value)) * 1000) / 1000;
}

export function adjustConfidence(value: number, outcome: UnderstandOutcome): number {
  return clampConfidence(value + CONFIDENCE_DELTA[outcome]);
}

/** Longest common directory of repo-relative files ("" when they only share the root). */
export function commonDirectory(files: readonly string[]): string {
  const dirs = files.map((f) => f.replace(/^\.\//, '').split('/').filter(Boolean).slice(0, -1));
  if (!dirs.length) return '';
  let common = dirs[0];
  for (const d of dirs.slice(1)) {
    let i = 0;
    while (i < common.length && i < d.length && common[i] === d[i]) i++;
    common = common.slice(0, i);
  }
  return common.join('/');
}

/**
 * The key a territory's confidence is stored under: the longest common directory of the module's
 * own anchors (of its descendants' anchors if it has none), or the node id when that is the repo
 * root or there are no anchors. Own anchors first, because descendants often add test files
 * elsewhere (test/round.test.ts), which would widen "src/money" to the root.
 */
export function modulePath(index: GraphIndex, nodeId: string): string {
  const id = index.territoryOf(nodeId) ?? nodeId;
  const node = index.byId.get(id);
  if (!node) return id;
  let files = node.anchors.map((a) => a.file);
  if (!files.length) files = index.descendants(id).flatMap((n) => n.anchors.map((a) => a.file));
  return commonDirectory(files) || id;
}

// Keys come from the graph (agent output), so "__proto__" must stay an ordinary key.
function own<T>(obj: Record<string, T> | undefined, key: string): T | undefined {
  return obj && Object.prototype.hasOwnProperty.call(obj, key) ? obj[key] : undefined;
}

function put<T>(obj: Record<string, T>, key: string, value: T): void {
  Object.defineProperty(obj, key, { value, enumerable: true, writable: true, configurable: true });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseRecord(raw: unknown): ConfidenceRecord | undefined {
  if (!isRecord(raw) || typeof raw.confidence !== 'number' || !Number.isFinite(raw.confidence) || typeof raw.lastTouched !== 'string') return undefined;
  return { confidence: clampConfidence(raw.confidence), lastTouched: raw.lastTouched };
}

/** Reads the stored value defensively: anything malformed is dropped, not trusted. */
export function parseConfidenceData(raw: unknown): ConfidenceData {
  const out: ConfidenceData = {};
  if (!isRecord(raw)) return out;
  for (const [repo, modules] of Object.entries(raw)) {
    if (!isRecord(modules)) continue;
    const records: Record<string, ConfidenceRecord> = {};
    for (const [path, rec] of Object.entries(modules)) {
      const r = parseRecord(rec);
      if (r) put(records, path, r);
    }
    put(out, repo, records);
  }
  return out;
}

/**
 * A store over one repo's slice of the data. `save` gets the whole updated value (a fresh object),
 * e.g. `(d) => globalState.update(CONFIDENCE_STATE_KEY, d)`.
 */
export function scopedConfidenceStore(data: ConfidenceData, repoKey: string, save: (data: ConfidenceData) => void): ConfidenceStore {
  let current = data;
  return {
    get: (path) => {
      const r = own(own(current, repoKey), path);
      return r ? { ...r } : undefined;
    },
    set: (path, value) => {
      const next: ConfidenceData = {};
      for (const [k, v] of Object.entries(current)) put(next, k, v);
      const records: Record<string, ConfidenceRecord> = {};
      for (const [k, v] of Object.entries(own(current, repoKey) ?? {})) put(records, k, v);
      put(records, path, { confidence: clampConfidence(value.confidence), lastTouched: value.lastTouched });
      put(next, repoKey, records);
      current = next;
      save(next);
    },
  };
}

/** In-memory store for tests and the browser harness. */
export class MemoryConfidenceStore implements ConfidenceStore {
  private readonly records = new Map<string, ConfidenceRecord>();

  constructor(initial: Record<string, ConfidenceRecord> = {}) {
    for (const [k, v] of Object.entries(initial)) this.records.set(k, { ...v });
  }

  get(modulePath: string): ConfidenceRecord | undefined {
    const r = this.records.get(modulePath);
    return r ? { ...r } : undefined;
  }

  set(modulePath: string, value: ConfidenceRecord): void {
    this.records.set(modulePath, { confidence: clampConfidence(value.confidence), lastTouched: value.lastTouched });
  }

  toJSON(): Record<string, ConfidenceRecord> {
    return Object.fromEntries(this.records);
  }
}

/**
 * "host/owner/repo" for a git remote URL, lower-cased, without credentials, port, scheme or ".git",
 * so https and ssh clones of one repo share a key. Undefined when it doesn't look like a remote.
 */
export function normaliseOriginUrl(url: string): string | undefined {
  const text = url.trim();
  let host: string;
  let path: string;
  const scp = /^(?:[^@/\s]+@)?([^:/\s]+):(?!\/\/)(.+)$/.exec(text);
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) {
    let u: URL;
    try {
      u = new URL(text);
    } catch {
      return undefined;
    }
    if (u.protocol === 'file:') return undefined;
    host = u.hostname;
    path = decodeURIComponentSafe(u.pathname);
  } else if (scp && !/^[a-z]$/i.test(scp[1])) {
    // scp-like "git@host:owner/repo.git"; a one-letter "host" is a Windows drive ("C:\…").
    host = scp[1];
    path = scp[2];
  } else {
    return undefined;
  }
  const clean = path.replace(/^\/+|\/+$/g, '').replace(/\.git$/i, '');
  if (!host || !clean) return undefined;
  return `${host}/${clean}`.toLowerCase();
}

function decodeURIComponentSafe(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/** repoKey for the confidence store: "sample:<package>", the normalised origin, or the repo root. */
export function confidenceRepoKey(opts: { sample?: string; originUrl?: string; repoRoot: string }): string {
  if (opts.sample) return `sample:${opts.sample}`;
  return (opts.originUrl && normaliseOriginUrl(opts.originUrl)) || opts.repoRoot;
}

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, it } from 'node:test';
import type { GraphNode, ReviewGraph } from '../../src/contract/graph';
import {
  adjustConfidence,
  clampConfidence,
  commonDirectory,
  confidenceRepoKey,
  FAMILIARITY_START,
  MemoryConfidenceStore,
  modulePath,
  normaliseOriginUrl,
  parseConfidenceData,
  scopedConfidenceStore,
  type ConfidenceData,
} from '../../src/review/confidence';
import { GraphIndex } from '../../src/review/order';

const FIXTURES = resolve(__dirname, '../../fixtures');
const sampleGraph = (): ReviewGraph => JSON.parse(readFileSync(join(FIXTURES, 'sample-graph.json'), 'utf8')) as ReviewGraph;

const node = (id: string, kind: GraphNode['kind'], files: string[], parent?: string): GraphNode => ({
  id,
  label: id,
  kind,
  ...(parent ? { parent } : {}),
  change: 'modified',
  risk: { signals: {}, why: 'test' },
  summary: 'test',
  anchors: files.map((file) => ({ file, startLine: 1, endLine: 2 })),
});

const graphOf = (nodes: GraphNode[]): ReviewGraph => ({ contractVersion: '0.1', pr: { title: 't', base: 'b', head: 'h' }, orientation: 'o', nodes, edges: [], files: [] });

describe('commonDirectory', () => {
  it('finds the longest common directory of files', () => {
    assert.equal(commonDirectory(['src/money/round.ts', 'src/money/money.ts']), 'src/money');
    assert.equal(commonDirectory(['src/money/round.ts', 'src/money/sub/x.ts']), 'src/money');
    assert.equal(commonDirectory(['src/money/round.ts', 'test/round.test.ts']), '');
    assert.equal(commonDirectory(['./src/a.ts']), 'src');
    assert.equal(commonDirectory(['a.ts']), '');
    assert.equal(commonDirectory([]), '');
    assert.equal(commonDirectory(['src/moneybox/a.ts', 'src/money/b.ts']), 'src', 'whole segments only');
  });
});

describe('modulePath', () => {
  const index = new GraphIndex(sampleGraph());

  it('keys each sample territory by its directory, from any node inside it', () => {
    assert.deepEqual(
      index.territories.map((t) => modulePath(index, t.id)),
      ['src/money', 'src/invoice', 'src/tax', 'src/api'],
    );
    assert.equal(modulePath(index, 'money/roundToCents'), 'src/money', 'its anchors include test/round.test.ts, but the module’s own anchors win');
  });

  it("uses the descendants' anchors when the module has none, and the node id when nothing narrows it", () => {
    const g = graphOf([
      node('lib', 'module', []),
      node('lib/a', 'function', ['pkg/lib/a.ts'], 'lib'),
      node('lib/b', 'function', ['pkg/lib/b/b.ts'], 'lib'),
      node('root', 'module', ['a.ts', 'b.ts']),
      node('spread', 'module', ['src/x.ts', 'test/x.ts']),
      node('empty', 'module', []),
      node('ext/x', 'external', []),
    ]);
    const ix = new GraphIndex(g);
    assert.equal(modulePath(ix, 'lib'), 'pkg/lib');
    assert.equal(modulePath(ix, 'root'), 'root');
    assert.equal(modulePath(ix, 'spread'), 'spread');
    assert.equal(modulePath(ix, 'empty'), 'empty');
    assert.equal(modulePath(ix, 'ext/x'), 'ext/x');
    assert.equal(modulePath(ix, 'ghost'), 'ghost');
  });
});

describe('confidence arithmetic', () => {
  it('starts from familiarity', () => {
    assert.deepEqual(FAMILIARITY_START, { new: 0.2, some: 0.5, known: 0.8 });
  });

  it('adjusts by outcome and clamps to 0..1 without float noise', () => {
    assert.equal(adjustConfidence(0.5, 'firstTry'), 0.65);
    assert.equal(adjustConfidence(0.5, 'secondTry'), 0.55);
    assert.equal(adjustConfidence(0.5, 'partly'), 0.55);
    assert.equal(adjustConfidence(0.5, 'incorrect'), 0.4);
    assert.equal(adjustConfidence(0.95, 'firstTry'), 1);
    assert.equal(adjustConfidence(0.05, 'incorrect'), 0);
    assert.equal(adjustConfidence(0.1, 'secondTry') + 0, 0.15);
    assert.equal(clampConfidence(Number.NaN), 0);
    assert.equal(clampConfidence(Infinity), 0);
    assert.equal(clampConfidence(0.1 + 0.2), 0.3);
  });
});

describe('MemoryConfidenceStore', () => {
  it('stores clamped copies', () => {
    const store = new MemoryConfidenceStore({ a: { confidence: 0.5, lastTouched: 't0' } });
    const got = store.get('a')!;
    got.confidence = 0.9;
    assert.equal(store.get('a')!.confidence, 0.5);
    store.set('b', { confidence: 7, lastTouched: 't1' });
    assert.deepEqual(store.toJSON(), { a: { confidence: 0.5, lastTouched: 't0' }, b: { confidence: 1, lastTouched: 't1' } });
    assert.equal(store.get('c'), undefined);
  });
});

describe('scopedConfidenceStore', () => {
  it('reads and writes one repo’s records, saving a fresh whole value each time', () => {
    const data: ConfidenceData = { 'github.com/acme/ledger': { 'src/money': { confidence: 0.4, lastTouched: 't0' } }, other: { x: { confidence: 0.9, lastTouched: 't0' } } };
    const before = JSON.parse(JSON.stringify(data));
    const saves: ConfidenceData[] = [];
    const store = scopedConfidenceStore(data, 'github.com/acme/ledger', (d) => saves.push(d));
    assert.deepEqual(store.get('src/money'), { confidence: 0.4, lastTouched: 't0' });
    assert.equal(store.get('src/tax'), undefined);
    store.set('src/tax', { confidence: 0.5, lastTouched: 't1' });
    store.set('src/money', { confidence: -1, lastTouched: 't2' });
    assert.equal(saves.length, 2);
    assert.deepEqual(saves[1], {
      'github.com/acme/ledger': { 'src/money': { confidence: 0, lastTouched: 't2' }, 'src/tax': { confidence: 0.5, lastTouched: 't1' } },
      other: { x: { confidence: 0.9, lastTouched: 't0' } },
    });
    assert.notEqual(saves[0], saves[1]);
    assert.deepEqual(data, before, 'the value read from globalState is not mutated');
    assert.deepEqual(store.get('src/tax'), { confidence: 0.5, lastTouched: 't1' });
  });

  it('keeps hostile keys as ordinary keys', () => {
    const saves: ConfidenceData[] = [];
    const store = scopedConfidenceStore({}, '__proto__', (d) => saves.push(d));
    assert.equal(store.get('constructor'), undefined);
    store.set('__proto__', { confidence: 0.5, lastTouched: 't' });
    assert.deepEqual(store.get('__proto__'), { confidence: 0.5, lastTouched: 't' });
    const saved = saves[0];
    assert.ok(Object.prototype.hasOwnProperty.call(saved, '__proto__'));
    assert.equal(Object.getPrototypeOf(saved), Object.prototype);
    assert.equal(({} as Record<string, unknown>).confidence, undefined, 'Object.prototype untouched');
  });
});

describe('parseConfidenceData', () => {
  it('keeps well-formed records and drops the rest', () => {
    const parsed = parseConfidenceData({
      repo: { good: { confidence: 0.25, lastTouched: 't' }, high: { confidence: 3, lastTouched: 't' }, noDate: { confidence: 0.2 }, nan: { confidence: 'x', lastTouched: 't' } },
      broken: 'nope',
      list: [],
    });
    assert.deepEqual(parsed, { repo: { good: { confidence: 0.25, lastTouched: 't' }, high: { confidence: 1, lastTouched: 't' } } });
    assert.deepEqual(parseConfidenceData(undefined), {});
    assert.deepEqual(parseConfidenceData([1, 2]), {});
  });

  it('keeps "__proto__" as an own key', () => {
    const raw = JSON.parse('{"__proto__": {"__proto__": {"confidence": 0.5, "lastTouched": "t"}}}');
    const parsed = parseConfidenceData(raw);
    assert.ok(Object.prototype.hasOwnProperty.call(parsed, '__proto__'));
    assert.deepEqual(Object.getOwnPropertyDescriptor(Object.getOwnPropertyDescriptor(parsed, '__proto__')!.value, '__proto__')!.value, { confidence: 0.5, lastTouched: 't' });
  });
});

describe('repo keys', () => {
  it('normalises https and ssh remotes of one repo to the same key', () => {
    const key = 'github.com/acme/ledger';
    assert.equal(normaliseOriginUrl('https://github.com/acme/ledger.git'), key);
    assert.equal(normaliseOriginUrl('https://user:token@GitHub.com/Acme/Ledger'), key);
    assert.equal(normaliseOriginUrl('git@github.com:acme/ledger.git'), key);
    assert.equal(normaliseOriginUrl('ssh://git@github.com:22/acme/ledger.git'), key);
    assert.equal(normaliseOriginUrl(' https://github.com/acme/ledger/ '), key);
    assert.equal(normaliseOriginUrl('https://gitlab.example.com/group/sub/repo.git'), 'gitlab.example.com/group/sub/repo');
  });

  it('rejects things that are not remotes', () => {
    assert.equal(normaliseOriginUrl('file:///home/me/repo'), undefined);
    assert.equal(normaliseOriginUrl('C:\\repos\\ledger'), undefined);
    assert.equal(normaliseOriginUrl('/home/me/repo'), undefined);
    assert.equal(normaliseOriginUrl('https://github.com/'), undefined);
    assert.equal(normaliseOriginUrl('http://[bad'), undefined);
    assert.equal(normaliseOriginUrl(''), undefined);
  });

  it('keys the sample by package, else the origin, else the repo root', () => {
    assert.equal(confidenceRepoKey({ sample: '@acme/ledger', originUrl: 'git@github.com:a/b.git', repoRoot: '/r' }), 'sample:@acme/ledger');
    assert.equal(confidenceRepoKey({ originUrl: 'git@github.com:a/b.git', repoRoot: '/r' }), 'github.com/a/b');
    assert.equal(confidenceRepoKey({ originUrl: 'not a remote', repoRoot: '/r' }), '/r');
    assert.equal(confidenceRepoKey({ repoRoot: '/r' }), '/r');
  });
});

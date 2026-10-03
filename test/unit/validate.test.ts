import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { join } from 'node:path';
import { canonicalPath, validateGraph } from '../../src/contract/validate';
import { FAKE_REPO, fixtureGraph, readFixtureFile } from './helpers';

const opts = { readFile: readFixtureFile };

function errorsOf(input: unknown, withFiles = true): string[] {
  const r = validateGraph(input, withFiles ? opts : {});
  assert.equal(r.ok, false, 'expected validation to fail');
  return r.ok ? [] : r.errors;
}

describe('validateGraph', () => {
  it('accepts the fixture graph with no warnings', () => {
    const r = validateGraph(fixtureGraph(), opts);
    assert.ok(r.ok, r.ok ? '' : r.errors.join('\n'));
    assert.deepEqual(r.warnings, []);
    assert.equal(r.graph.nodes.length, 7);
  });

  describe('schema failures', () => {
    it('rejects a missing required field', () => {
      const g: Record<string, unknown> = { ...fixtureGraph() };
      delete g.orientation;
      assert.match(errorsOf(g).join('\n'), /orientation/);
    });

    it('rejects an unknown node kind', () => {
      const g = fixtureGraph();
      (g.nodes[1] as { kind: string }).kind = 'method';
      assert.match(errorsOf(g).join('\n'), /\/nodes\/1\/kind .*allowed values/);
    });

    it('rejects the wrong contract version', () => {
      const g = fixtureGraph() as unknown as { contractVersion: string };
      g.contractVersion = '0.2';
      assert.match(errorsOf(g).join('\n'), /contractVersion/);
    });

    it('rejects properties outside the contract', () => {
      const g = fixtureGraph() as unknown as { nodes: Record<string, unknown>[] };
      g.nodes[0].colour = 'red';
      assert.match(errorsOf(g).join('\n'), /additional properties/);
    });

    it('rejects line numbers below 1', () => {
      const g = fixtureGraph();
      g.files[0].regions[0].startLine = 0;
      assert.match(errorsOf(g).join('\n'), /startLine must be >= 1/);
    });

    it('accepts any characters in symbols (display-only, escaped by hosts) but caps their length', () => {
      for (const ok of ['Foo.[Symbol.iterator]', '`backtick test name`', 'x'.repeat(200)]) {
        const g = fixtureGraph();
        g.files[0].regions[1].symbol = ok;
        g.nodes[1].anchors[0].symbol = ok;
        assert.ok(validateGraph(g, opts).ok, ok);
      }
      const long = fixtureGraph();
      long.files[0].regions[1].symbol = 'x'.repeat(201);
      assert.match(errorsOf(long).join('\n'), /\/files\/0\/regions\/1\/symbol must NOT have more than 200/);
    });

    it('rejects non-objects', () => {
      assert.ok(errorsOf('not a graph').length > 0);
      assert.ok(errorsOf(null).length > 0);
    });
  });

  describe('semantic failures', () => {
    it('rejects duplicate node ids', () => {
      const g = fixtureGraph();
      g.nodes.push({ ...g.nodes[1] });
      assert.match(errorsOf(g).join('\n'), /duplicate node id "money\/roundToCents"/);
    });

    it('rejects an unknown parent', () => {
      const g = fixtureGraph();
      g.nodes[1].parent = 'monee';
      assert.match(errorsOf(g).join('\n'), /unknown parent "monee"/);
    });

    it('rejects a parent that cannot contain nodes', () => {
      const g = fixtureGraph();
      g.nodes[2].parent = 'money/roundToCents';
      assert.match(errorsOf(g).join('\n'), /of kind function, which cannot contain nodes/);
    });

    it('rejects a module with a parent and a symbol without one', () => {
      const g = fixtureGraph();
      g.nodes[3].parent = 'money';
      delete g.nodes[4].parent;
      const errors = errorsOf(g).join('\n');
      assert.match(errors, /module "checkout" must not have a parent/);
      assert.match(errors, /function "checkout\/orderTotal" needs a parent/);
    });

    it('rejects parent cycles', () => {
      const g = fixtureGraph();
      g.nodes.push(
        { ...g.nodes[1], id: 'money/A', kind: 'class', parent: 'money/B' },
        { ...g.nodes[1], id: 'money/B', kind: 'class', parent: 'money/A' },
      );
      assert.match(errorsOf(g).join('\n'), /parent cycle/);
    });

    it('rejects an edge to an unknown node', () => {
      const g = fixtureGraph();
      g.edges.push({ from: 'checkout/orderTotal', to: 'money/ceilToCents', kind: 'calls' });
      assert.match(errorsOf(g).join('\n'), /edge checkout\/orderTotal -> money\/ceilToCents has unknown target/);
    });

    it('rejects an anchor beyond the end of the file', () => {
      const g = fixtureGraph();
      g.nodes[1].anchors[0].endLine = 20; // money/round.ts has 19 lines
      assert.match(errorsOf(g).join('\n'), /node "money\/roundToCents": lines 3-20 exceed money\/round.ts \(19 lines\)/);
    });

    it('rejects an anchor into a file missing from the head revision', () => {
      const g = fixtureGraph();
      g.nodes[1].anchors[0].file = 'money/gone.ts';
      assert.match(errorsOf(g).join('\n'), /file "money\/gone.ts" not found/);
    });

    it('only checks line bounds when it can read files', () => {
      const g = fixtureGraph();
      g.nodes[1].anchors[0].endLine = 20;
      assert.ok(validateGraph(g).ok);
    });

    it('rejects an anchor that ends before it starts', () => {
      const g = fixtureGraph();
      g.nodes[1].anchors[0] = { file: 'money/round.ts', startLine: 9, endLine: 4 };
      assert.match(errorsOf(g).join('\n'), /ends before it starts/);
    });

    it('rejects partially overlapping regions but allows nesting', () => {
      const nested = fixtureGraph();
      nested.files[0].regions.push({ startLine: 8, endLine: 13, symbol: 'body', gist: 'The rounding itself' });
      assert.ok(validateGraph(nested, opts).ok, 'nested region should be fine');

      const overlap = fixtureGraph();
      overlap.files[0].regions[2].startLine = 12; // 3-14 and 12-19
      assert.match(errorsOf(overlap).join('\n'), /money\/round.ts regions 3-14 and 12-19 partially overlap/);
    });

    it('catches partial overlaps that are not adjacent once sorted', () => {
      const g = fixtureGraph();
      g.files[0].regions = [
        { startLine: 1, endLine: 10, gist: 'outer' },
        { startLine: 2, endLine: 3, gist: 'nested in 1-10' },
        { startLine: 5, endLine: 15, gist: 'sticks out of 1-10' },
      ];
      assert.match(errorsOf(g).join('\n'), /money\/round.ts regions 1-10 and 5-15 partially overlap/);
    });

    it('accepts nesting with a shared start line in either order', () => {
      const g = fixtureGraph();
      g.files[0].regions = [
        { startLine: 3, endLine: 5, gist: 'inner' },
        { startLine: 3, endLine: 14, gist: 'outer' },
      ];
      const r = validateGraph(g, opts);
      assert.ok(r.ok, r.ok ? '' : r.errors.join('\n'));
    });

    it('rejects duplicate file outlines', () => {
      const g = fixtureGraph();
      g.files.push({ ...g.files[0] });
      assert.match(errorsOf(g).join('\n'), /duplicate file outline "money\/round.ts"/);
    });

    it('rejects a consumes edge that runs from a symbol to an external', () => {
      const g = fixtureGraph();
      g.edges[2] = { from: 'money/roundToCents', to: 'ext/invoice-service', kind: 'consumes' };
      assert.match(errorsOf(g).join('\n'), /edge money\/roundToCents -> ext\/invoice-service \(consumes\) is reversed/);
    });

    it('rejects any edge into an external, and consumes between in-repo nodes', () => {
      const g = fixtureGraph();
      g.edges.push({ from: 'money/roundToCents', to: 'ext/storefront-web', kind: 'affects' });
      g.edges.push({ from: 'checkout/orderTotal', to: 'money/formatCents', kind: 'consumes' });
      const errors = errorsOf(g).join('\n');
      assert.match(errors, /money\/roundToCents -> ext\/storefront-web \(affects\) points at external/);
      assert.match(errors, /checkout\/orderTotal -> money\/formatCents \(consumes\) is 'consumes' but "checkout\/orderTotal" is not an external/);
    });
  });

  describe('paths', () => {
    it('canonicalises spellings of a repo-relative path', () => {
      assert.equal(canonicalPath('./money/round.ts'), 'money/round.ts');
      assert.equal(canonicalPath('money\\round.ts'), 'money/round.ts');
      assert.equal(canonicalPath('money//./round.ts'), 'money/round.ts');
      assert.equal(canonicalPath('.\\money\\round.ts'), 'money/round.ts');
    });

    it('refuses paths that leave the repo or name no file', () => {
      for (const p of ['../x.ts', 'money/../../x.ts', 'money/../round.ts', '/etc/passwd', 'C:\\x.ts', '\\\\server\\share\\x.ts', '.', './']) {
        assert.equal(canonicalPath(p), undefined, p);
      }
    });

    it('makes absolute paths under the root relative', () => {
      assert.equal(canonicalPath('/home/u/repo/money/round.ts', '/home/u/repo'), 'money/round.ts');
      assert.equal(canonicalPath('/home/u/repo/money/round.ts', '/home/u/repo/'), 'money/round.ts');
      assert.equal(canonicalPath('C:\\Repo\\money\\round.ts', 'c:\\Repo'), 'money/round.ts');
      assert.equal(canonicalPath('/home/u/repo2/x.ts', '/home/u/repo'), undefined);
      assert.equal(canonicalPath('/home/u/repo', '/home/u/repo'), undefined);
      assert.equal(canonicalPath('/home/u/repo/../x.ts', '/home/u/repo'), undefined);
    });

    it('returns canonical paths, so anchors and outlines compare equal', () => {
      const g = fixtureGraph();
      g.nodes[1].anchors[0].file = './money/round.ts';
      g.files[1].path = 'checkout\\total.ts';
      const r = validateGraph(g, opts);
      assert.ok(r.ok, r.ok ? '' : r.errors.join('\n'));
      assert.deepEqual(r.warnings, []);
      assert.equal(r.graph.nodes[1].anchors[0].file, 'money/round.ts');
      assert.equal(r.graph.files[1].path, 'checkout/total.ts');
      assert.equal(g.nodes[1].anchors[0].file, './money/round.ts', 'input is not mutated');
    });

    it('rejects absolute and ".." paths in strict mode without reading them', () => {
      const g = fixtureGraph();
      g.nodes[1].anchors[0].file = join(FAKE_REPO, 'money/round.ts');
      g.files[1].path = '../checkout/total.ts';
      const read: string[] = [];
      const r = validateGraph(g, { readFile: (p) => (read.push(p), readFixtureFile(p)) });
      assert.equal(r.ok, false);
      const errors = r.ok ? '' : r.errors.join('\n');
      assert.match(errors, /node "money\/roundToCents" anchor path ".*round.ts" must be repo-relative/);
      assert.match(errors, /file outline path "..\/checkout\/total.ts" must be repo-relative/);
      assert.doesNotMatch(errors, /not found/);
      assert.ok(read.every((p) => !p.startsWith('/') && !p.includes('..')), read.join(' '));
    });
  });

  describe('warnings', () => {
    it('warns about symbols without anchors and anchors without outlines', () => {
      const g = fixtureGraph();
      g.nodes[2].anchors = [];
      g.files = g.files.filter((f) => f.path !== 'checkout/total.ts');
      const r = validateGraph(g, opts);
      assert.ok(r.ok);
      assert.ok(r.warnings.some((w) => /"money\/formatCents" has no anchors/.test(w)));
      assert.ok(r.warnings.some((w) => /"checkout\/total.ts".*has no outline/.test(w)));
    });

    it('drops duplicate edges in both modes', () => {
      for (const repair of [false, true]) {
        const g = fixtureGraph();
        g.edges.push({ ...g.edges[2], label: 'same edge again' });
        const r = validateGraph(g, { ...opts, repair });
        assert.ok(r.ok, r.ok ? '' : r.errors.join('\n'));
        assert.equal(r.graph.edges.length, g.edges.length - 1);
        assert.ok(r.warnings.some((w) => /dropped duplicate edge ext\/invoice-service -> money\/roundToCents \(consumes\)/.test(w)));
      }
    });
  });

  describe('repair mode (agent output)', () => {
    const repairOpts = { readFile: readFixtureFile, repair: true };

    it('clamps an anchor past the end of the file and warns', () => {
      const g = fixtureGraph();
      g.nodes[1].anchors[0].endLine = 20; // money/round.ts has 19 lines
      const r = validateGraph(g, repairOpts);
      assert.ok(r.ok, r.ok ? '' : r.errors.join('\n'));
      assert.equal(r.graph.nodes[1].anchors[0].endLine, 19);
      assert.ok(r.warnings.some((w) => /clamped an anchor of "money\/roundToCents"/.test(w)));
      assert.equal(g.nodes[1].anchors[0].endLine, 20, 'input is not mutated');
    });

    it('trims the earlier of two partially overlapping regions', () => {
      const g = fixtureGraph();
      g.files[0].regions[2].startLine = 12; // 3-14 and 12-19
      const r = validateGraph(g, repairOpts);
      assert.ok(r.ok, r.ok ? '' : r.errors.join('\n'));
      const regions = r.graph.files[0].regions.map((x) => `${x.startLine}-${x.endLine}`);
      assert.ok(regions.includes('3-11') && regions.includes('12-19'), regions.join(' '));
      assert.ok(r.warnings.some((w) => /regions 3-14 and 12-19 overlapped; the first now ends at 11/.test(w)));
    });

    it('drops an overlapping region when trimming would break nesting', () => {
      const g = fixtureGraph();
      g.files[0].regions.push({ startLine: 10, endLine: 14, symbol: 'inner', gist: 'nested in 3-14' });
      g.files[0].regions[2].startLine = 12; // 12-19 clashes with 3-14, whose child 10-14 would stick out
      const r = validateGraph(g, repairOpts);
      assert.ok(r.ok, r.ok ? '' : r.errors.join('\n'));
      assert.ok(r.warnings.some((w) => /dropped money\/round.ts region 12-19/.test(w)), r.warnings.join('\n'));
    });

    it('drops ranges in files missing from the head revision', () => {
      const g = fixtureGraph();
      g.nodes[1].anchors.push({ file: 'money/gone.ts', startLine: 1, endLine: 2 });
      g.files.push({ path: 'money/gone.ts', regions: [{ startLine: 1, endLine: 2, gist: 'gone' }] });
      const r = validateGraph(g, repairOpts);
      assert.ok(r.ok, r.ok ? '' : r.errors.join('\n'));
      assert.ok(!r.graph.nodes[1].anchors.some((a) => a.file === 'money/gone.ts'));
      assert.ok(!r.graph.files.some((f) => f.path === 'money/gone.ts'));
    });

    it('warns when it swaps an inverted range', () => {
      const g = fixtureGraph();
      g.nodes[1].anchors[0] = { file: 'money/round.ts', startLine: 14, endLine: 3, symbol: 'roundToCents' };
      const r = validateGraph(g, repairOpts);
      assert.ok(r.ok, r.ok ? '' : r.errors.join('\n'));
      assert.deepEqual([r.graph.nodes[1].anchors[0].startLine, r.graph.nodes[1].anchors[0].endLine], [3, 14]);
      assert.ok(r.warnings.some((w) => /swapped an anchor of "money\/roundToCents" money\/round.ts:14-3/.test(w)), r.warnings.join('\n'));
    });

    it('makes absolute paths under repoRoot relative, and drops ones outside it', () => {
      const g = fixtureGraph();
      g.nodes[1].anchors[0].file = join(FAKE_REPO, 'money/round.ts');
      g.files[0].path = join(FAKE_REPO, 'money/round.ts');
      g.nodes[4].anchors[0].file = '/elsewhere/checkout/total.ts';
      const r = validateGraph(g, { ...repairOpts, repoRoot: FAKE_REPO });
      assert.ok(r.ok, r.ok ? '' : r.errors.join('\n'));
      assert.equal(r.graph.nodes[1].anchors[0].file, 'money/round.ts');
      assert.equal(r.graph.files[0].path, 'money/round.ts');
      assert.deepEqual(r.graph.nodes[4].anchors, []);
      assert.ok(r.warnings.some((w) => /made absolute path ".*round.ts" repo-relative/.test(w)));
      assert.ok(r.warnings.some((w) => /dropped an anchor of "checkout\/orderTotal", path "\/elsewhere\/checkout\/total.ts" is not inside the repo/.test(w)));
      assert.ok(!r.warnings.some((w) => /has no outline/.test(w)), r.warnings.join('\n'));
    });

    it('fails rather than return a review with no code left', () => {
      const g = fixtureGraph();
      for (const n of g.nodes) for (const a of n.anchors) a.file = join(FAKE_REPO, a.file);
      for (const f of g.files) f.path = join(FAKE_REPO, f.path);
      const r = validateGraph(g, repairOpts); // no repoRoot, so nothing can be rebased
      assert.equal(r.ok, false);
      assert.match(r.ok ? '' : r.errors.join('\n'), /could not be matched to the repo: repair dropped every anchor and every file outline/);
    });

    it('fails when every outline is dropped even if anchors survive', () => {
      const g = fixtureGraph();
      for (const f of g.files) f.path = `gone/${f.path}`;
      const r = validateGraph(g, repairOpts);
      assert.equal(r.ok, false);
      assert.match(r.ok ? '' : r.errors.join('\n'), /repair dropped every file outline/);
    });

    it('flips a reversed consumes edge and drops other edges into externals', () => {
      const g = fixtureGraph();
      g.edges[2] = { from: 'money/roundToCents', to: 'ext/invoice-service', kind: 'consumes' };
      g.edges.push({ from: 'money/formatCents', to: 'ext/storefront-web', kind: 'affects' });
      const r = validateGraph(g, repairOpts);
      assert.ok(r.ok, r.ok ? '' : r.errors.join('\n'));
      const edges = r.graph.edges.map((e) => `${e.from}>${e.to}:${e.kind}`);
      assert.ok(edges.includes('ext/invoice-service>money/roundToCents:consumes'), edges.join(' '));
      assert.ok(!edges.some((e) => e.includes('>ext/')), edges.join(' '));
      assert.ok(r.warnings.some((w) => /flipped edge money\/roundToCents -> ext\/invoice-service/.test(w)));
      assert.ok(r.warnings.some((w) => /dropped edge money\/formatCents -> ext\/storefront-web \(affects\)/.test(w)));
    });

    it('dedupes a flipped edge that repeats an existing one', () => {
      const g = fixtureGraph();
      g.edges.push({ from: 'money/roundToCents', to: 'ext/invoice-service', kind: 'consumes' });
      const r = validateGraph(g, repairOpts);
      assert.ok(r.ok, r.ok ? '' : r.errors.join('\n'));
      assert.equal(r.graph.edges.length, fixtureGraph().edges.length);
    });

    it('keeps every repair inside the strict region rules (random regions)', () => {
      const rand = mulberry32(0xf11e5);
      const int = (lo: number, hi: number) => lo + Math.floor(rand() * (hi - lo + 1));
      for (let run = 0; run < 2000; run++) {
        const g = fixtureGraph();
        g.files[0].regions = Array.from({ length: int(1, 9) }, (_, i) => {
          const start = int(1, 22); // money/round.ts has 19 lines; some ranges run past it or are inverted
          return { startLine: start, endLine: Math.max(1, start + int(-3, 12)), gist: `r${i}` };
        });
        const input = JSON.stringify(g.files[0].regions);
        const repaired = validateGraph(g, repairOpts);
        assert.ok(repaired.ok, `${input}\n${repaired.ok ? '' : repaired.errors.join('\n')}`);
        const strict = validateGraph(repaired.graph, opts);
        assert.ok(strict.ok, `${input} -> ${JSON.stringify(repaired.graph.files[0].regions)}\n${strict.ok ? '' : strict.errors.join('\n')}`);
      }
    });

    it('still rejects structural problems', () => {
      const g = fixtureGraph();
      g.edges.push({ from: 'checkout/orderTotal', to: 'money/ceilToCents', kind: 'calls' });
      const r = validateGraph(g, repairOpts);
      assert.equal(r.ok, false);
    });
  });
});

/** Small seeded PRNG, so a failing random case reproduces. */
function mulberry32(seed: number): () => number {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { validateGraph } from '../../src/contract/validate';
import { fixtureGraph, readFixtureFile } from './helpers';

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

    it('rejects duplicate file outlines', () => {
      const g = fixtureGraph();
      g.files.push({ ...g.files[0] });
      assert.match(errorsOf(g).join('\n'), /duplicate file outline "money\/round.ts"/);
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
  });
});

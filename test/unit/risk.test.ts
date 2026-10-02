import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { GraphNode, ReviewGraph } from '../../src/contract/graph';
import { scoreGraph, scoreRisk } from '../../src/contract/risk';
import { fixtureGraph } from './helpers';

describe('scoreRisk', () => {
  it('is monotonic in externalConsumers, and saturates', () => {
    const levels = [0, 1, 2, 3, 4, 10, 100].map((n) => scoreRisk({ externalConsumers: n, behaviourChange: true }).level);
    for (let i = 1; i < levels.length; i++) assert.ok(levels[i] >= levels[i - 1], `level fell from ${levels[i - 1]} to ${levels[i]}`);
    assert.ok(levels[1] > levels[0] && levels[2] > levels[1] && levels[3] > levels[2], 'each of the first consumers must count');
    assert.equal(levels[6], levels[3], 'beyond 3 consumers the signal is saturated');
  });

  it('lets downstream impact dominate the agent judgement', () => {
    const judgementOnly = scoreRisk({}, 1);
    const consumersOnly = scoreRisk({ externalConsumers: 3 });
    assert.ok(consumersOnly.level > judgementOnly.level);
    assert.equal(judgementOnly.band, 'low');
  });

  it('counts missing tests only when known to be missing', () => {
    assert.equal(scoreRisk({ hasTests: false }).level, 0.1);
    assert.equal(scoreRisk({}).level, 0);
    assert.equal(scoreRisk({ hasTests: true }).level, 0);
  });

  it('bands by level and stays within 0..1', () => {
    const all = scoreRisk({ externalConsumers: 50, publicApi: true, internalFanOut: 50, behaviourChange: true, hasTests: false, linesChanged: 5000 }, 1);
    assert.equal(all.level, 1);
    assert.equal(all.band, 'high');
    assert.equal(scoreRisk({ behaviourChange: true, publicApi: true }).band, 'medium');
    assert.ok(all.contributions.every((c) => c.points > 0 && c.label.length > 0));
  });
});

describe('scoreGraph', () => {
  const node = (id: string, parent: string | undefined, kind: GraphNode['kind'], signals: GraphNode['risk']['signals']): GraphNode => ({
    id,
    label: id,
    kind,
    ...(parent ? { parent } : {}),
    change: 'modified',
    risk: { signals, why: 'test' },
    summary: 'test',
    anchors: [],
  });

  it('raises a parent to its riskiest descendant, through every level', () => {
    const g: ReviewGraph = {
      contractVersion: '0.1',
      pr: { title: 't', base: 'b', head: 'h' },
      orientation: 'o',
      nodes: [
        node('mod', undefined, 'module', {}),
        node('mod/file.ts', 'mod', 'file', {}),
        node('mod/Cls', 'mod/file.ts', 'class', { linesChanged: 10 }),
        node('mod/Cls.method', 'mod/Cls', 'function', { externalConsumers: 3, behaviourChange: true }),
      ],
      edges: [],
      files: [],
    };
    const s = scoreGraph(g);
    const leaf = s.get('mod/Cls.method')!;
    for (const id of ['mod/Cls', 'mod/file.ts', 'mod']) {
      assert.equal(s.get(id)!.level, leaf.level, `${id} should inherit the leaf level`);
      assert.equal(s.get(id)!.inheritedFrom, 'mod/Cls.method');
    }
    assert.equal(leaf.inheritedFrom, undefined);
  });

  it('keeps a parent that is already riskier than its children', () => {
    const g = fixtureGraph();
    const s = scoreGraph(g);
    const money = s.get('money')!;
    for (const id of ['money/roundToCents', 'money/formatCents']) assert.ok(money.level >= s.get(id)!.level);
    assert.equal(s.size, g.nodes.length);
  });
});

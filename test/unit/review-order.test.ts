import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, it } from 'node:test';
import type { GraphNode, ReviewGraph } from '../../src/contract/graph';
import type { Depth, Question, QuestionSet } from '../../src/contract/questions';
import { GraphIndex, includesDepth, isDepth, isRevealed, orderQuestions } from '../../src/review/order';

const FIXTURES = resolve(__dirname, '../../fixtures');
const sampleGraph = (): ReviewGraph => JSON.parse(readFileSync(join(FIXTURES, 'sample-graph.json'), 'utf8')) as ReviewGraph;
const sampleQuestions = (): QuestionSet => JSON.parse(readFileSync(join(FIXTURES, 'sample-questions.json'), 'utf8')) as QuestionSet;

const node = (id: string, kind: GraphNode['kind'], parent?: string, signals: GraphNode['risk']['signals'] = {}): GraphNode => ({
  id,
  label: id,
  kind,
  ...(parent ? { parent } : {}),
  change: 'modified',
  risk: { signals, why: 'test' },
  summary: 'test',
  anchors: [],
});

const graphOf = (nodes: GraphNode[], edges: ReviewGraph['edges'] = []): ReviewGraph => ({
  contractVersion: '0.1',
  pr: { title: 't', base: 'main', head: 'feature' },
  orientation: 'o',
  nodes,
  edges,
  files: [],
});

const q = (id: string, nodeId: string, stage: Question['stage'] = 'check', depth: Depth = 'skim'): Question => ({ id, nodeId, stage, purpose: 'judge', depth, prompt: id });

describe('depth', () => {
  it('nests skim ⊂ standard ⊂ deep', () => {
    assert.equal(includesDepth('skim', 'skim'), true);
    assert.equal(includesDepth('skim', 'standard'), false);
    assert.equal(includesDepth('standard', 'skim'), true);
    assert.equal(includesDepth('standard', 'deep'), false);
    assert.equal(includesDepth('deep', 'standard'), true);
    assert.equal(includesDepth('deep', 'deep'), true);
  });

  it('recognises depths', () => {
    assert.equal(isDepth('standard'), true);
    assert.equal(isDepth('Standard'), false);
    assert.equal(isDepth(undefined), false);
    assert.equal(isDepth(2), false);
  });
});

describe('GraphIndex on the sample', () => {
  const index = new GraphIndex(sampleGraph());

  it('finds the territories: top-level modules, in graph order', () => {
    assert.deepEqual(
      index.territories.map((t) => t.id),
      ['money', 'invoice', 'tax', 'api'],
    );
  });

  it('maps nodes to territories; externals and unknown ids have none', () => {
    assert.equal(index.territoryOf('money/roundToCents'), 'money');
    assert.equal(index.territoryOf('money'), 'money');
    assert.equal(index.territoryOf('ext/checkout-web'), undefined);
    assert.equal(index.territoryOf('nowhere'), undefined);
    assert.equal(index.isTerritory('money'), true);
    assert.equal(index.isTerritory('money/roundToCents'), false);
    assert.equal(index.isTerritory('ext/reporting'), false);
    assert.equal(index.root('invoice/applyDiscount'), 'invoice');
    assert.equal(index.root('nowhere'), undefined);
    assert.equal(index.depthOf('invoice/applyDiscount'), 1);
    assert.equal(index.depthOf('invoice'), 0);
  });

  it('lists descendants', () => {
    assert.deepEqual(
      index.descendants('invoice').map((n) => n.id),
      ['invoice/Invoice.total', 'invoice/applyDiscount', 'invoice/findDiscount'],
    );
    assert.deepEqual(index.descendants('ext/reporting'), []);
  });

  it('groups an external with the riskiest territory it is linked to', () => {
    assert.deepEqual(index.linkedTerritories('ext/checkout-web'), ['money']);
    assert.deepEqual(index.linkedTerritories('ext/mobile-app'), ['api']);
    assert.deepEqual(index.linkedTerritories('money/roundToCents'), [], 'only externals have linked territories');
    assert.equal(index.groupOf('ext/checkout-web'), 'money');
    assert.equal(index.groupOf('ext/mobile-app'), 'api');
    assert.equal(index.groupOf('money/Money.multiply'), 'money');
  });

  it('scores risk with scoreGraph: money is the riskiest territory', () => {
    const order = index.territories.map((t) => t.id).sort((a, b) => index.riskOf(b) - index.riskOf(a));
    assert.deepEqual(order, ['money', 'invoice', 'api', 'tax']);
    assert.equal(index.riskOf('nowhere'), 0);
  });
});

describe('GraphIndex edge cases', () => {
  it('links externals through edges in either direction, riskiest first, and groups unlinked ones alone', () => {
    const g = graphOf(
      [node('a', 'module'), node('a/f', 'function', 'a', { externalConsumers: 3 }), node('b', 'module'), node('b/g', 'function', 'b'), node('ext/x', 'external'), node('ext/lonely', 'external')],
      [
        { from: 'b/g', to: 'ext/x', kind: 'affects' },
        { from: 'ext/x', to: 'a/f', kind: 'consumes' },
      ],
    );
    const index = new GraphIndex(g);
    assert.deepEqual(index.linkedTerritories('ext/x'), ['a', 'b']);
    assert.equal(index.groupOf('ext/x'), 'a');
    assert.equal(index.groupOf('ext/lonely'), 'ext/lonely');
  });

  // Parent cycles never get this far: validateGraph rejects them (and scoreGraph would recurse forever).
  it("treats a node whose parent doesn't exist as top level", () => {
    const g = graphOf([node('orphan', 'function', 'ghost'), node('m', 'module'), node('m/f', 'function', 'm')]);
    const index = new GraphIndex(g);
    assert.deepEqual(
      index.territories.map((t) => t.id),
      ['m'],
    );
    assert.equal(index.root('orphan'), 'orphan');
    assert.equal(index.territoryOf('orphan'), undefined, 'a top-level function is no territory');
    assert.equal(index.groupOf('orphan'), 'orphan');
    assert.equal(index.depthOf('orphan'), 0);
    assert.equal(isRevealed(index, new Set(), 'orphan'), true, 'nothing to fog it under');
  });
});

describe('isRevealed', () => {
  const index = new GraphIndex(sampleGraph());

  it('reveals a territory and everything in it once explored', () => {
    const explored = new Set<string>();
    assert.equal(isRevealed(index, explored, 'money'), false);
    assert.equal(isRevealed(index, explored, 'money/roundToCents'), false);
    explored.add('money');
    assert.equal(isRevealed(index, explored, 'money'), true);
    assert.equal(isRevealed(index, explored, 'money/roundToCents'), true);
    assert.equal(isRevealed(index, explored, 'invoice/applyDiscount'), false);
  });

  it('reveals an external once a territory it is linked to is explored', () => {
    assert.equal(isRevealed(index, new Set(), 'ext/checkout-web'), false);
    assert.equal(isRevealed(index, new Set(['money']), 'ext/checkout-web'), true);
    assert.equal(isRevealed(index, new Set(['money']), 'ext/mobile-app'), false);
    assert.equal(isRevealed(index, new Set(['api']), 'ext/mobile-app'), true);
  });

  it('always reveals an unlinked external and never an unknown id', () => {
    const lonely = new GraphIndex(graphOf([node('m', 'module'), node('ext/x', 'external')]));
    assert.equal(isRevealed(lonely, new Set(), 'ext/x'), true);
    assert.equal(isRevealed(lonely, new Set(['m']), 'ghost'), false);
  });
});

describe('orderQuestions', () => {
  const index = new GraphIndex(sampleGraph());
  const idsOf = (qs: Question[]) => qs.map((x) => x.id);

  it('asks the riskiest territory first, predict before check, riskier nodes first within a stage', () => {
    const qs = [
      q('tax-check', 'tax/vatRate'),
      q('multiply', 'money/Money.multiply'),
      q('round', 'money/roundToCents'),
      q('money-predict', 'money', 'predict'),
      q('invoice-predict-child', 'invoice/applyDiscount', 'predict'),
      q('invoice-predict', 'invoice', 'predict'),
      q('consumer', 'ext/checkout-web'),
      q('api-check', 'api/createInvoiceHandler'),
    ];
    assert.deepEqual(idsOf(orderQuestions(index, qs, 'deep')), ['money-predict', 'round', 'multiply', 'consumer', 'invoice-predict', 'invoice-predict-child', 'api-check', 'tax-check']);
  });

  it('filters by depth', () => {
    const qs = [q('s', 'money', 'predict', 'skim'), q('m', 'money/roundToCents', 'check', 'standard'), q('d', 'money/Money.allocate', 'check', 'deep')];
    assert.deepEqual(idsOf(orderQuestions(index, qs, 'skim')), ['s']);
    assert.deepEqual(idsOf(orderQuestions(index, qs, 'standard')), ['s', 'm']);
    assert.deepEqual(idsOf(orderQuestions(index, qs, 'deep')), ['s', 'm', 'd']);
  });

  it('drops unknown nodes and repeated ids, keeping the first', () => {
    const first = q('dup', 'money');
    const qs = [q('ghost', 'nowhere'), first, { ...q('dup', 'tax'), prompt: 'second' }];
    const out = orderQuestions(index, qs, 'deep');
    assert.deepEqual(idsOf(out), ['dup']);
    assert.equal(out[0].nodeId, 'money');
  });

  it('keeps the question-set order for ties', () => {
    const qs = [q('one', 'money/roundToCents'), q('two', 'money/roundToCents'), q('three', 'money/roundToCents')];
    assert.deepEqual(idsOf(orderQuestions(index, qs, 'skim')), ['one', 'two', 'three']);
  });

  it('does not mutate its input', () => {
    const qs = [q('b', 'tax'), q('a', 'money')];
    const copy = JSON.parse(JSON.stringify(qs));
    orderQuestions(index, qs, 'deep');
    assert.deepEqual(qs, copy);
  });

  it('orders the bundled sample questions at every depth', () => {
    const set = sampleQuestions();
    assert.deepEqual(idsOf(orderQuestions(index, set.questions, 'skim')), ['q-money-predict', 'q-round-default', 'q-total-tests', 'q-discount-tests']);
    assert.deepEqual(idsOf(orderQuestions(index, set.questions, 'standard')), [
      'q-money-predict',
      'q-round-default',
      'q-multiply-ties',
      'q-checkout-web',
      'q-invoice-predict',
      'q-total-tests',
      'q-total-discount',
      'q-discount-tests',
      'q-api-predict',
      'q-handler-null',
      'q-tax-predict',
      'q-vatrate-ebook',
    ]);
    assert.equal(orderQuestions(index, set.questions, 'deep').length, 14);
  });
});

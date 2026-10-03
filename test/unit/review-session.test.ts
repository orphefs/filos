// End-to-end sessions on the review model: a long scripted didactic review of the sample PR with a
// hand-made question set (agent available, a GitHub target), and a walk through every territory of
// the bundled fixtures/sample-questions.json at every depth.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, it } from 'node:test';
import type { ReviewGraph } from '../../src/contract/graph';
import { DEPTHS, type Question, type QuestionSet } from '../../src/contract/questions';
import { MemoryConfidenceStore } from '../../src/review/confidence';
import { buildGithubReview, diffHeadLines } from '../../src/review/github';
import { reviewToMarkdown } from '../../src/review/markdown';
import { NO_EFFECT, ReviewModel, type ReviewEffect } from '../../src/review/model';
import { GraphIndex } from '../../src/review/order';
import type { PostTarget, ReviewSnapshot } from '../../src/review/types';

const FIXTURES = resolve(__dirname, '../../fixtures');
const graph = (): ReviewGraph => JSON.parse(readFileSync(join(FIXTURES, 'sample-graph.json'), 'utf8')) as ReviewGraph;
const sampleQuestions = (): QuestionSet => JSON.parse(readFileSync(join(FIXTURES, 'sample-questions.json'), 'utf8')) as QuestionSet;

function clock(): () => string {
  let t = 0;
  return () => new Date(Date.UTC(2026, 9, 3, 12, 0, t++)).toISOString();
}

function sampleHeadLines(): Map<string, Set<number>> {
  const out = spawnSync('git', ['diff', '--no-index', '--no-ext-diff', '--no-color', '--src-prefix=a/', '--dst-prefix=b/', 'base', 'head'], { cwd: join(FIXTURES, 'sample-repo'), encoding: 'utf8' });
  assert.equal(out.status, 1, out.stderr);
  return new Map([...diffHeadLines(out.stdout)].map(([k, v]) => [k.replace(/^head\//, ''), v]));
}

const GITHUB: PostTarget = { kind: 'github', repo: 'acme/ledger', number: 42, url: 'https://github.com/acme/ledger/pull/42' };

const abc = (correct: string) => ['a', 'b', 'c'].map((id) => ({ id, text: `Option ${id}`, explain: `Why ${id}.`, ...(id === correct ? { correct: true } : {}) }));

/** The scripted session's questions. tax has no predict question, so its gate is the synthetic one. */
function sessionQuestions(): QuestionSet {
  return {
    contractVersion: '0.1',
    depth: { proposed: 'standard', why: 'A public default changes under three repos.' },
    questions: [
      { id: 'p-money', nodeId: 'money', stage: 'predict', purpose: 'understand', depth: 'skim', prompt: 'Three repos call roundToCents without a mode. What happens when they upgrade?', hint: 'What does 0.125 round to now?', choices: abc('b') },
      {
        id: 'j-round',
        nodeId: 'money/roundToCents',
        stage: 'check',
        purpose: 'judge',
        depth: 'skim',
        prompt: 'Should the default change?',
        choices: [
          { id: 'fine', text: 'Fine as is', explain: 'Nothing to say.' },
          { id: 'block', text: 'Keep half-up as the default', explain: 'Drafts a blocking comment.', comment: { file: 'src/money/round.ts', line: 18, severity: 'blocking', body: 'Please keep half-up as the default and add an opt-in mode.' } },
        ],
      },
      { id: 'o-checkout', nodeId: 'ext/checkout-web', stage: 'check', purpose: 'understand', depth: 'standard', prompt: 'What changes for checkout-web?', reference: 'Prices ending in half a cent round down on even cents.' },
      { id: 'p-invoice', nodeId: 'invoice', stage: 'predict', purpose: 'understand', depth: 'standard', prompt: 'Where will invoice totals move?', reference: 'VAT is rounded once per rate, not per line.' },
      {
        id: 'j-discount',
        nodeId: 'invoice/applyDiscount',
        stage: 'check',
        purpose: 'judge',
        depth: 'standard',
        prompt: 'applyDiscount has no tests. What should the review say?',
        choices: [
          { id: 'fine', text: 'Fine', explain: 'Nothing to say.' },
          { id: 'tests', text: 'Ask for unit tests', explain: 'Drafts a blocking comment.', comment: { file: 'src/invoice/discount.ts', line: 23, severity: 'blocking', body: 'Please add unit tests for applyDiscount.' } },
        ],
      },
      { id: 'c-vat', nodeId: 'tax/vatRate', stage: 'check', purpose: 'understand', depth: 'standard', prompt: 'What does vatRate return for ebooks?', choices: abc('a') },
      { id: 'p-api', nodeId: 'api/createInvoiceHandler', stage: 'predict', purpose: 'understand', depth: 'standard', prompt: 'What will the handler pass on?', hint: 'Look at the discount code.', choices: abc('c') },
      { id: 'o-mobile', nodeId: 'ext/mobile-app', stage: 'check', purpose: 'understand', depth: 'deep', prompt: 'What will mobile-app see?', reference: 'Totals in the response can differ by a cent.' },
    ],
  };
}

const territory = (s: ReviewSnapshot, id: string) => s.territories.find((t) => t.nodeId === id)!;

describe('a scripted didactic review of the sample PR', () => {
  it('walks the map, builds the review, posts it once and survives a reload', () => {
    // The reviewer has seen tax before (another PR): its familiarity step is skipped.
    const store = new MemoryConfidenceStore({ 'src/tax': { confidence: 0.7, lastTouched: '2026-09-01T00:00:00.000Z' } });
    const opts = { graph: graph(), questions: sessionQuestions(), questionsStatus: { state: 'ready' as const }, mode: 'didactic' as const, confidence: store, agentAvailable: true, post: GITHUB, now: clock() };
    const m = new ReviewModel(opts);
    let s = m.snapshot();

    // The map is all fog; money (riskiest) comes first; tax gets a synthetic gate.
    assert.deepEqual(s.coverage, { explored: 0, total: 4 });
    assert.deepEqual(
      s.questions.map((q) => q.id),
      ['p-money', 'j-round', 'o-checkout', 'p-invoice', 'j-discount', 'p-api', 'gate:tax', 'c-vat'],
    );
    assert.equal(m.answer('j-round', 'block'), NO_EFFECT, 'no answers inside fog');
    assert.equal(m.select('money/roundToCents'), false, 'no code inside fog');

    // Enter money: familiarity, then the prediction. Wrong first (a hint), then right.
    m.enter('money');
    assert.deepEqual(m.snapshot().gate, { nodeId: 'money', step: 'familiarity' });
    m.familiarity('money', 'new');
    assert.deepEqual(store.get('src/money')?.confidence, 0.2);
    assert.deepEqual(m.snapshot().gate, { nodeId: 'money', step: 'predict', questionId: 'p-money' });
    m.answer('p-money', 'a');
    s = m.snapshot();
    assert.equal(s.answers['p-money'].attempts[0].reply, 'What does 0.125 round to now?');
    assert.equal(territory(s, 'money').explored, false);
    m.answer('p-money', 'b');
    s = m.snapshot();
    assert.equal(territory(s, 'money').explored, true);
    assert.equal(store.get('src/money')?.confidence, 0.25, 'right on the second try: +0.05');
    assert.equal(m.select('money'), true, 'Continue into money');
    assert.equal(m.snapshot().gate, undefined);

    // Inside money: a judgement drafts a comment; the consumer question is graded by the agent.
    m.answer('j-round', 'block');
    assert.deepEqual(
      m.snapshot().comments.map((c) => [c.id, c.severity, c.file, c.line]),
      [['c1', 'blocking', 'src/money/round.ts', 18]],
    );
    let effect: ReviewEffect = m.answer('o-checkout', undefined, 'Nothing changes.');
    assert.deepEqual(effect, { kind: 'evaluate', questionId: 'o-checkout', attempt: 1, text: 'Nothing changes.' });
    m.applyEvaluation('o-checkout', { verdict: 'incorrect', reply: 'What happens to a price of 10.125?' });
    effect = m.answer('o-checkout', undefined, 'Half-cent prices round to the even cent.');
    assert.deepEqual(effect, { kind: 'evaluate', questionId: 'o-checkout', attempt: 2, text: 'Half-cent prices round to the even cent.' });
    m.applyEvaluation('o-checkout', { verdict: 'correct', reply: 'Yes: 10.125 becomes 10.12.' });
    assert.equal(store.get('src/money')?.confidence, 0.3);
    assert.equal(territory(m.snapshot(), 'money').questionsDone, 3);

    // Start entering invoice; its open prediction goes to the agent. The reviewer wanders off to tax meanwhile.
    m.enter('invoice');
    m.familiarity('invoice', 'known');
    assert.equal(m.snapshot().gate?.questionId, 'p-invoice');
    effect = m.answer('p-invoice', undefined, 'VAT rounding per rate.');
    assert.equal(effect.kind, 'evaluate');
    m.enter('tax');
    assert.deepEqual(m.snapshot().gate, { nodeId: 'tax', step: 'predict', questionId: 'gate:tax' }, 'tax is known from before: straight to the prediction');
    m.answer('gate:tax', undefined, 'Ebook VAT.');
    s = m.snapshot();
    assert.equal(territory(s, 'tax').explored, true);
    assert.equal(store.get('src/tax')?.confidence, 0.7, 'a noted prediction is never graded');
    m.select('tax/vatRate');

    // The invoice grade lands after its gate closed: invoice opens anyway, and the reply drafts a question.
    m.applyEvaluation('p-invoice', { verdict: 'partly', reply: 'Per rate, yes; and discounts apply first.', comment: { severity: 'question', body: 'Has finance agreed to rounding VAT once per rate?' } });
    s = m.snapshot();
    assert.equal(territory(s, 'invoice').explored, true);
    assert.deepEqual(s.coverage, { explored: 3, total: 4 });
    assert.equal(store.get('src/invoice')?.confidence, 0.85);
    assert.equal(m.select('ext/mobile-app'), false, 'mobile-app consumes api, still in fog');

    m.answer('c-vat', 'b');
    assert.equal(m.snapshot().answers['c-vat'].done, true, 'no hint: explained at once');
    assert.equal(store.get('src/tax')?.confidence, 0.6);
    m.answer('j-discount', 'tests');

    // The last territory.
    m.enter('api');
    m.familiarity('api', 'some');
    assert.equal(m.snapshot().gate?.questionId, 'p-api', "a descendant's predict question guards the module");
    m.answer('p-api', 'c');
    assert.equal(m.select('api'), true);
    s = m.snapshot();
    assert.deepEqual(s.coverage, { explored: 4, total: 4 });
    assert.equal(store.get('src/api')?.confidence, 0.65);
    assert.ok(
      s.questions.every((q) => s.answers[q.id]?.done),
      'every question at standard is done',
    );

    // Deeper: the mobile-app question appears; grading fails, so the reviewer self-checks.
    m.setDepth('deep');
    effect = m.answer('o-mobile', undefined, 'Totals can be a cent off.');
    assert.equal(effect.kind, 'evaluate');
    m.failEvaluation('o-mobile', 'Your Claude login has expired.');
    assert.equal(m.snapshot().answers['o-mobile'].attempts[0].reply, 'Totals in the response can differ by a cent.');
    m.selfCheck('o-mobile', true);
    assert.equal(store.get('src/api')?.confidence, 0.8, 'the consumer question counts for api');

    // Comments: agent drafts, a reviewer note, a thread with an adopted proposal.
    assert.deepEqual(m.draftWithAgent(), { kind: 'draft' });
    const asked = m.answered().map((x) => x.question.id);
    assert.deepEqual(asked, ['p-money', 'j-round', 'o-checkout', 'p-invoice', 'j-discount', 'p-api', 'o-mobile', 'gate:tax', 'c-vat']);
    m.applyAgentDrafts([
      { nodeId: 'money/Money.multiply', file: 'src/money/money.ts', line: 36, severity: 'suggestion', body: 'multiply now inherits the new tie rule; worth a note in the changelog.' },
      { severity: 'nit', body: 'Thanks for the clear description!' },
      { file: 'src/invoice/discount.ts', line: 23, severity: 'blocking', body: 'Please add unit tests for applyDiscount.' },
    ]);
    m.addNote('Consider a migration note for the three consuming repos.', 'money');
    s = m.snapshot();
    assert.deepEqual(
      s.comments.map((c) => [c.id, c.origin.kind, c.severity]),
      [
        ['c1', 'question', 'blocking'],
        ['c2', 'question', 'question'],
        ['c3', 'question', 'blocking'],
        ['c4', 'agent', 'suggestion'],
        ['c5', 'agent', 'nit'],
        ['c6', 'note', 'suggestion'],
      ],
      'the duplicate of c3 was skipped',
    );
    assert.deepEqual(m.thread('c1', 'Softer, and give the numbers.'), { kind: 'thread', commentId: 'c1' });
    m.applyThreadReply('c1', { reply: 'Here is a softer version.', proposal: 'Could half-up stay the default? 0.125 now rounds to 0.12, which changes totals for three repos.' });
    m.adoptProposal('c1', 1);
    for (const id of ['c1', 'c2', 'c3', 'c4']) m.commentAction(id, 'accept');
    m.commentAction('c5', 'reject');

    // Post: confirmation and gh are the host's; the model hands over the accepted, unposted comments.
    effect = m.requestPost();
    assert.equal(effect.kind, 'post');
    const toPost = effect.kind === 'post' ? effect.comments : [];
    assert.deepEqual(
      toPost.map((c) => c.id),
      ['c1', 'c2', 'c3', 'c4'],
    );
    const review = buildGithubReview(toPost, sampleHeadLines());
    assert.deepEqual(review.comments, [
      { path: 'src/money/round.ts', line: 18, side: 'RIGHT', body: '**Blocking:** Could half-up stay the default? 0.125 now rounds to 0.12, which changes totals for three repos.' },
      { path: 'src/invoice/discount.ts', line: 23, side: 'RIGHT', body: '**Blocking:** Please add unit tests for applyDiscount.' },
      { path: 'src/money/money.ts', line: 36, side: 'RIGHT', body: '**Suggestion:** multiply now inherits the new tie rule; worth a note in the changelog.' },
    ]);
    assert.equal(review.body, '**Question:** Has finance agreed to rounding VAT once per rate?');
    m.setPostState({ target: GITHUB, status: 'posting' });
    m.setPostState({ target: GITHUB, status: 'posted', url: 'https://github.com/acme/ledger/pull/42#pullrequestreview-9' });
    const again = m.requestPost();
    assert.deepEqual(again.kind === 'post' && again.comments, [], 'posted comments are not posted again');

    // Export: accepted, then drafts marked; the rejected thank-you is gone; nothing private.
    const md = reviewToMarkdown(m.snapshot(), m.graph, "Switch to banker's rounding and add invoice discounts");
    assert.match(md, /## Comments \(4\)/);
    assert.match(md, /## Drafts, not accepted \(1\)\n\n\*\*Draft\*\* · Suggestion · on ` money ` · reviewer note/);
    assert.doesNotMatch(md, /Thanks for the clear description/);
    assert.doesNotMatch(md, /confiden|0\.8|familiar/i);

    // Reload: the same review, minus the post status (the host knows that from GitHub), and no double post.
    const saved = JSON.parse(JSON.stringify(m.persisted()));
    const before = m.snapshot();
    const reloaded = new ReviewModel({ ...opts, persisted: saved, now: clock() });
    const after = reloaded.snapshot();
    assert.deepEqual({ ...after, post: undefined }, { ...before, post: undefined });
    assert.deepEqual(after.post, { target: GITHUB, status: 'idle' });
    const afterReload = reloaded.requestPost();
    assert.deepEqual(afterReload.kind === 'post' && afterReload.comments, []);
    // Private confidence: module path, value and last-touched date, nothing else.
    const records = store.toJSON();
    assert.deepEqual(
      Object.fromEntries(Object.entries(records).map(([k, v]) => [k, v.confidence])),
      { 'src/tax': 0.6, 'src/money': 0.3, 'src/invoice': 0.85, 'src/api': 0.8 },
    );
    assert.ok(Object.values(records).every((r) => Object.keys(r).sort().join() === 'confidence,lastTouched'));
    const touched = Object.entries(records)
      .sort((a, b) => a[1].lastTouched.localeCompare(b[1].lastTouched))
      .map(([k]) => k);
    assert.deepEqual(touched, ['src/money', 'src/invoice', 'src/tax', 'src/api'], 'in the order the reviewer last answered there');
  });
});

describe('walking the bundled sample questions', () => {
  const index = new GraphIndex(graph());

  /** Answers well: the right choice, a commenting judgement, or an open answer the reviewer gets right. */
  function answerWell(m: ReviewModel, q: Question): void {
    if (q.choices) {
      const choice = q.purpose === 'judge' ? (q.choices.find((c) => c.comment) ?? q.choices[0]) : q.choices.find((c) => c.correct)!;
      m.answer(q.id, choice.id);
    } else {
      const effect = m.answer(q.id, undefined, 'My best understanding.');
      if (effect.kind === 'evaluate') m.applyEvaluation(q.id, { verdict: 'correct', reply: 'Right.' });
      else if (m.snapshot().answers[q.id]?.awaitingSelfCheck) m.selfCheck(q.id, true);
    }
    assert.equal(m.snapshot().answers[q.id]?.done, true, `${q.id} is done`);
  }

  for (const depth of DEPTHS) {
    it(`explores every territory at ${depth} depth in didactic mode, without an agent`, () => {
      const store = new MemoryConfidenceStore();
      const m = new ReviewModel({ graph: graph(), questions: sampleQuestions(), questionsStatus: { state: 'ready' }, mode: 'didactic', confidence: store, agentAvailable: false, post: { kind: 'none', reason: 'Sample' }, now: clock() });
      m.setDepth(depth);
      // Risk order: money, invoice, api, tax.
      const order = [...new Set(m.snapshot().questions.map((q) => index.groupOf(q.nodeId)))];
      assert.deepEqual(order, ['money', 'invoice', 'api', 'tax']);
      for (const t of order) {
        assert.equal(m.select(t), false, `${t} starts in fog`);
        m.enter(t);
        m.familiarity(t, 'some');
        const gate = m.snapshot().gate!;
        assert.equal(gate.step, 'predict');
        const real = m.snapshot().questions.find((q) => q.stage === 'predict' && index.territoryOf(q.nodeId) === t && !q.id.startsWith('gate:'));
        assert.equal(gate.questionId, real?.id ?? `gate:${t}`, `${t}'s gate question at ${depth}`);
        answerWell(m, m.snapshot().questions.find((q) => q.id === gate.questionId)!);
        assert.equal(territory(m.snapshot(), t).explored, true, `${t} explored`);
        assert.equal(m.select(t), true);
        for (const q of m.snapshot().questions.filter((x) => index.groupOf(x.nodeId) === t && !m.snapshot().answers[x.id]?.done)) answerWell(m, q);
        const tt = territory(m.snapshot(), t);
        assert.equal(tt.questionsDone, tt.questionsTotal, `${t}: all its questions done`);
      }
      const s = m.snapshot();
      assert.deepEqual(s.coverage, { explored: 4, total: 4 });
      assert.ok(s.questions.every((q) => s.answers[q.id]?.done));

      // Confidence: from "some" (0.5), +0.15 per understand question got right first time.
      for (const t of order) {
        const understood = s.questions.filter((q) => index.groupOf(q.nodeId) === t && q.purpose === 'understand' && !q.id.startsWith('gate:')).length;
        assert.equal(store.get(m.modulePathOf(t))?.confidence, Math.min(1, Math.round((0.5 + 0.15 * understood) * 1000) / 1000), `${t} confidence`);
      }

      // Every judgement drafted a comment, and each sits on a line of the PR's diff.
      const judged = s.questions.filter((q) => q.purpose === 'judge' && q.choices);
      assert.equal(s.comments.length, judged.length);
      for (const c of s.comments) m.commentAction(c.id, 'accept');
      const review = buildGithubReview(m.snapshot().comments, sampleHeadLines());
      assert.equal(review.comments.length, judged.length, 'all inline');
      assert.equal(review.body, '');
    });
  }

  it('answers everything in fast mode with an agent grading open answers', () => {
    const m = new ReviewModel({ graph: graph(), questions: sampleQuestions(), questionsStatus: { state: 'ready' }, mode: 'fast', confidence: new MemoryConfidenceStore(), agentAvailable: true, post: GITHUB, now: clock() });
    m.setDepth('deep');
    const evaluated: string[] = [];
    for (const q of m.snapshot().questions) {
      if (!q.choices) evaluated.push(q.id);
      answerWell(m, q);
    }
    assert.deepEqual(evaluated, ['q-checkout-web', 'q-total-groups']);
    const s = m.snapshot();
    assert.equal(s.questions.length, 14);
    assert.deepEqual(s.coverage, { explored: 0, total: 4 }, 'fast mode has no map to explore');
    assert.ok(!s.questions.some((q) => q.id.startsWith('gate:')));
  });
});

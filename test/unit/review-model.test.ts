import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, it } from 'node:test';
import type { ReviewGraph } from '../../src/contract/graph';
import type { CommentSeed, Depth, Question, QuestionSet } from '../../src/contract/questions';
import { MemoryConfidenceStore } from '../../src/review/confidence';
import { gateQuestionId, NO_EFFECT, NOTED_PREDICTION_REPLY, parsePersistedReview, ReviewModel, type ReviewModelOptions } from '../../src/review/model';
import type { PostTarget } from '../../src/review/types';

const FIXTURES = resolve(__dirname, '../../fixtures');
const graph = (): ReviewGraph => JSON.parse(readFileSync(join(FIXTURES, 'sample-graph.json'), 'utf8')) as ReviewGraph;

/** Deterministic, strictly increasing ISO timestamps. */
function clock(): () => string {
  let t = 0;
  return () => new Date(Date.UTC(2026, 9, 3, 10, 0, t++)).toISOString();
}

const mc = (id: string, nodeId: string, stage: Question['stage'], depth: Depth, correct: string, hint?: string): Question => ({
  id,
  nodeId,
  stage,
  purpose: 'understand',
  depth,
  prompt: `${id}?`,
  ...(hint ? { hint } : {}),
  choices: ['a', 'b', 'c'].map((c) => ({ id: c, text: `Choice ${c}`, explain: `Explain ${c}.`, ...(c === correct ? { correct: true } : {}) })),
});

const BLOCK: CommentSeed = { file: 'src/money/round.ts', line: 18, severity: 'blocking', body: 'Please keep half-up as the default.' };
const ASK: CommentSeed = { file: 'src/money/round.ts', line: 18, severity: 'question', body: 'Is the new default intended for every caller?' };

/**
 * A small hand-made set over the sample graph. Territories by risk: money, invoice, api, tax.
 * money: a predict MCQ with a hint; invoice: a predict on the module (standard) and on a
 * descendant (deep); api: only a descendant's predict; tax: no predict at all.
 */
function questions(): QuestionSet {
  return {
    contractVersion: '0.1',
    depth: { proposed: 'standard', why: 'A public default changes.' },
    questions: [
      mc('p-money', 'money', 'predict', 'skim', 'a', 'What does the default do on a tie?'),
      {
        id: 'j-round',
        nodeId: 'money/roundToCents',
        stage: 'check',
        purpose: 'judge',
        depth: 'skim',
        prompt: 'What should the review say about the default?',
        choices: [
          { id: 'fine', text: 'Fine as is', explain: 'Then the review says nothing.' },
          { id: 'block', text: 'Keep half-up', explain: 'Drafts a blocking comment.', comment: BLOCK },
          { id: 'ask', text: 'Ask', explain: 'Drafts a question.', comment: ASK },
        ],
      },
      mc('c-multiply', 'money/Money.multiply', 'check', 'standard', 'b'),
      { id: 'o-checkout', nodeId: 'ext/checkout-web', stage: 'check', purpose: 'understand', depth: 'standard', prompt: 'What changes for checkout-web?', reference: 'Totals shift by a cent on ties.', hint: 'Which ties?' },
      mc('p-invoice', 'invoice', 'predict', 'standard', 'c', 'Where is VAT rounded now?'),
      mc('p-discount', 'invoice/applyDiscount', 'predict', 'deep', 'a'),
      { id: 'o-total', nodeId: 'invoice/Invoice.total', stage: 'check', purpose: 'understand', depth: 'standard', prompt: 'How is VAT grouped?', reference: 'Once per rate, not per line.' },
      mc('p-api', 'api/createInvoiceHandler', 'predict', 'standard', 'b', 'What does the handler pass on?'),
      { id: 'o-noref', nodeId: 'tax/vatRate', stage: 'check', purpose: 'understand', depth: 'standard', prompt: 'What does vatRate return for ebooks?' },
      { id: 'j-vat', nodeId: 'tax', stage: 'check', purpose: 'judge', depth: 'deep', prompt: 'Anything to add about tax?' },
    ],
  };
}

const GITHUB: PostTarget = { kind: 'github', repo: 'acme/ledger', number: 7, url: 'https://github.com/acme/ledger/pull/7' };

function make(over: Partial<ReviewModelOptions> = {}): { model: ReviewModel; store: MemoryConfidenceStore } {
  const store = (over.confidence as MemoryConfidenceStore | undefined) ?? new MemoryConfidenceStore();
  const model = new ReviewModel({
    graph: graph(),
    questions: questions(),
    questionsStatus: { state: 'ready' },
    mode: 'fast',
    agentAvailable: false,
    post: { kind: 'none', reason: 'The sample has no pull request.' },
    now: clock(),
    ...over,
    confidence: store,
  });
  return { model, store };
}

const ids = (m: ReviewModel) => m.snapshot().questions.map((q) => q.id);
const answerOf = (m: ReviewModel, id: string) => m.snapshot().answers[id];
const comments = (m: ReviewModel) => m.snapshot().comments;

/** Didactic: explore a territory through its gate, answering its gate question right. */
function explore(m: ReviewModel, nodeId: string, answer: { choiceId?: string; text?: string }): void {
  m.enter(nodeId);
  if (m.snapshot().gate?.step === 'familiarity') m.familiarity(nodeId, 'some');
  const qid = m.snapshot().gate?.questionId;
  assert.ok(qid, `gate of ${nodeId} has a question`);
  m.answer(qid, answer.choiceId, answer.text);
  assert.ok(m.snapshot().territories.find((t) => t.nodeId === nodeId)?.explored, `${nodeId} explored`);
  assert.equal(m.select(nodeId), true);
}

describe('ReviewModel', () => {
  describe('snapshot', () => {
    it('starts at the proposed depth with questions in asking order', () => {
      const { model } = make();
      const s = model.snapshot();
      // counts: what each depth would ask, so the depth menu can say so before switching.
      assert.deepEqual(s.depth, { proposed: 'standard', why: 'A public default changes.', chosen: 'standard', counts: { skim: 2, standard: 8, deep: 10 } });
      assert.deepEqual(ids(model), ['p-money', 'j-round', 'c-multiply', 'o-checkout', 'p-invoice', 'o-total', 'p-api', 'o-noref']);
      assert.deepEqual(
        s.territories.map((t) => t.nodeId),
        ['money', 'invoice', 'tax', 'api'],
      );
      assert.deepEqual(s.coverage, { explored: 0, total: 4 });
      assert.deepEqual(s.answers, {});
      assert.deepEqual(s.comments, []);
      assert.equal(s.gate, undefined);
      assert.equal(s.mode, 'fast');
      assert.equal(s.agentAvailable, false);
      assert.deepEqual(s.questionsStatus, { state: 'ready' });
      assert.deepEqual(s.post, { target: { kind: 'none', reason: 'The sample has no pull request.' }, status: 'idle' });
      assert.equal(s.draftingPending, undefined);
    });

    it('counts questions per territory, with an external grouped under the territory it consumes', () => {
      const s = make().model.snapshot();
      const money = s.territories.find((t) => t.nodeId === 'money')!;
      assert.equal(money.questionsTotal, 4, 'p-money, j-round, c-multiply and o-checkout (about ext/checkout-web)');
      assert.equal(money.questionsDone, 0);
      assert.equal(money.confidence, 0, 'no record yet');
      assert.equal(money.familiarity, undefined);
    });

    it('is a copy: changing it changes nothing in the model', () => {
      const { model } = make();
      model.answer('p-money', 'a');
      const s = model.snapshot();
      s.questions.length = 0;
      s.answers['p-money'].done = false;
      s.comments.push({ id: 'x', body: 'x', severity: 'nit', origin: { kind: 'note' }, status: 'accepted', amended: false, thread: [] });
      const again = model.snapshot();
      assert.equal(again.questions.length, 8);
      assert.equal(again.answers['p-money'].done, true);
      assert.equal(again.comments.length, 0);
    });

    it('works without a question set (status none or loading)', () => {
      const { model } = make({ questions: undefined, questionsStatus: { state: 'loading' } });
      const s = model.snapshot();
      assert.deepEqual(s.questions, []);
      assert.deepEqual(s.depth, { proposed: 'standard', why: '', chosen: 'standard' });
      assert.deepEqual(s.questionsStatus, { state: 'loading' });
      model.setQuestions(questions(), { state: 'ready' });
      assert.equal(model.snapshot().questions.length, 8);
    });
  });

  describe('depth', () => {
    it('filters skim ⊂ standard ⊂ deep and keeps the order', () => {
      const { model } = make();
      model.setDepth('skim');
      assert.deepEqual(ids(model), ['p-money', 'j-round']);
      model.setDepth('deep');
      assert.deepEqual(ids(model), ['p-money', 'j-round', 'c-multiply', 'o-checkout', 'p-invoice', 'p-discount', 'o-total', 'p-api', 'j-vat', 'o-noref']);
      assert.deepEqual(model.snapshot().depth.chosen, 'deep');
    });

    it('ignores a depth that is not one', () => {
      const { model } = make();
      model.setDepth('everything' as Depth);
      assert.equal(model.snapshot().depth.chosen, 'standard');
      assert.equal(model.persisted().chosenDepth, undefined, 'the proposal applies until the reviewer overrides it');
    });

    it("doesn't answer questions outside the chosen depth", () => {
      const { model } = make();
      model.setDepth('skim');
      assert.deepEqual(model.answer('c-multiply', 'b'), NO_EFFECT);
      assert.equal(answerOf(model, 'c-multiply'), undefined);
    });

    it('keeps answers when the depth goes down and back up', () => {
      const { model } = make();
      model.answer('c-multiply', 'b');
      model.setDepth('skim');
      model.setDepth('standard');
      assert.equal(answerOf(model, 'c-multiply').done, true);
    });
  });

  describe('multiple choice', () => {
    it('grades a right first answer as done, with its explanation', () => {
      const { model } = make();
      assert.deepEqual(model.answer('p-money', 'a'), NO_EFFECT);
      const a = answerOf(model, 'p-money');
      assert.equal(a.done, true);
      assert.deepEqual(a.attempts, [{ at: '2026-10-03T10:00:00.000Z', choiceId: 'a', verdict: 'correct', reply: 'Explain a.', by: 'choice' }]);
    });

    it('answers a wrong first try with the hint and lets the reviewer try again', () => {
      const { model } = make();
      model.answer('p-money', 'b');
      let a = answerOf(model, 'p-money');
      assert.equal(a.done, false);
      assert.equal(a.attempts[0].verdict, 'incorrect');
      assert.equal(a.attempts[0].reply, 'What does the default do on a tie?', 'a question back, not the answer');
      model.answer('p-money', 'a');
      a = answerOf(model, 'p-money');
      assert.equal(a.done, true);
      assert.deepEqual(
        a.attempts.map((x) => x.verdict),
        ['incorrect', 'correct'],
      );
    });

    it('explains after a second wrong try, naming the right answer, and is done', () => {
      const { model } = make();
      model.answer('p-money', 'b');
      model.answer('p-money', 'c');
      const a = answerOf(model, 'p-money');
      assert.equal(a.done, true);
      assert.equal(a.attempts[1].verdict, 'incorrect');
      assert.equal(a.attempts[1].reply, 'Explain c.\n\nAnswer: Choice a — Explain a.');
    });

    it('explains at once when there is no hint', () => {
      const { model } = make();
      model.answer('c-multiply', 'a');
      const a = answerOf(model, 'c-multiply');
      assert.equal(a.done, true);
      assert.equal(a.attempts.length, 1);
      assert.equal(a.attempts[0].reply, 'Explain a.\n\nAnswer: Choice b — Explain b.');
    });

    it('ignores unknown choices, unknown questions and answers to finished questions', () => {
      const { model } = make();
      model.answer('p-money', 'zzz');
      model.answer('nope', 'a');
      assert.deepEqual(model.snapshot().answers, {});
      model.answer('p-money', 'a');
      model.answer('p-money', 'b');
      assert.equal(answerOf(model, 'p-money').attempts.length, 1);
    });
  });

  describe('judge questions', () => {
    it('drafts the chosen comment seed, tied to the question and node', () => {
      const { model } = make();
      model.answer('j-round', 'block');
      const a = answerOf(model, 'j-round');
      assert.equal(a.done, true);
      assert.deepEqual(a.attempts[0], { at: '2026-10-03T10:00:00.000Z', choiceId: 'block', verdict: 'noted', reply: 'Drafts a blocking comment.', by: 'choice' });
      assert.deepEqual(comments(model), [
        {
          id: 'c1',
          nodeId: 'money/roundToCents',
          file: 'src/money/round.ts',
          line: 18,
          body: 'Please keep half-up as the default.',
          severity: 'blocking',
          origin: { kind: 'question', questionId: 'j-round', choiceId: 'block' },
          status: 'draft',
          amended: false,
          thread: [],
        },
      ]);
    });

    it('replaces the earlier draft when the judgement changes, unless it was accepted or amended', () => {
      const { model } = make();
      model.answer('j-round', 'block');
      model.answer('j-round', 'ask');
      assert.deepEqual(
        comments(model).map((c) => [c.id, c.severity]),
        [['c2', 'question']],
      );
      model.answer('j-round', 'fine');
      assert.deepEqual(comments(model), [], '"fine as is" drafts nothing and drops the draft');

      model.answer('j-round', 'block');
      model.commentAction('c3', 'accept');
      model.answer('j-round', 'ask');
      assert.deepEqual(
        comments(model).map((c) => [c.id, c.status]),
        [
          ['c3', 'accepted'],
          ['c4', 'draft'],
        ],
      );
      model.amend('c4', 'Is this intended? Three repos call it.');
      model.answer('j-round', 'fine');
      assert.deepEqual(
        comments(model).map((c) => c.id),
        ['c3', 'c4'],
        'accepted and amended drafts are the reviewer’s now',
      );
      assert.equal(answerOf(model, 'j-round').attempts.length, 6);
    });

    it('drops a rejected draft when the judgement changes', () => {
      const { model } = make();
      model.answer('j-round', 'block');
      model.commentAction('c1', 'reject');
      model.answer('j-round', 'ask');
      assert.deepEqual(
        comments(model).map((c) => c.id),
        ['c2'],
      );
    });

    it('keeps the draft (and adds no attempt) when the same choice is picked again', () => {
      const { model } = make();
      model.answer('j-round', 'block');
      model.answer('j-round', 'block');
      assert.equal(answerOf(model, 'j-round').attempts.length, 1);
      assert.equal(comments(model).length, 1);
    });

    it('notes an open judge answer without grading it', () => {
      const { model } = make({ agentAvailable: true });
      model.setDepth('deep');
      assert.deepEqual(model.answer('j-vat', undefined, '  Looks fine.  '), NO_EFFECT);
      assert.deepEqual(answerOf(model, 'j-vat').attempts[0], { at: '2026-10-03T10:00:00.000Z', text: 'Looks fine.', verdict: 'noted', reply: '', by: 'self' });
      assert.equal(model.needsAgentGrading('j-vat'), false);
    });
  });

  describe('open questions', () => {
    it('without an agent, shows the reference and waits for a self-check', () => {
      const { model } = make();
      assert.equal(model.needsAgentGrading('o-total'), false);
      model.answer('o-total', undefined, 'VAT per rate');
      let a = answerOf(model, 'o-total');
      assert.equal(a.awaitingSelfCheck, true);
      assert.equal(a.done, false);
      assert.equal(a.attempts[0].reply, 'Once per rate, not per line.');
      assert.equal(a.attempts[0].text, 'VAT per rate');
      model.answer('o-total', undefined, 'again');
      assert.equal(answerOf(model, 'o-total').attempts.length, 1, 'no new answer while the self-check is open');
      model.selfCheck('o-total', true);
      a = answerOf(model, 'o-total');
      assert.equal(a.done, true);
      assert.equal(a.awaitingSelfCheck, undefined);
      assert.equal(a.attempts[0].verdict, 'correct');
      assert.equal(a.attempts[0].by, 'self');
    });

    it('"I missed something" finishes it as incorrect', () => {
      const { model } = make();
      model.answer('o-total', undefined, 'no idea');
      model.selfCheck('o-total', false);
      assert.equal(answerOf(model, 'o-total').attempts[0].verdict, 'incorrect');
      assert.equal(answerOf(model, 'o-total').done, true);
      model.selfCheck('o-total', true);
      assert.equal(answerOf(model, 'o-total').attempts[0].verdict, 'incorrect', 'a self-check happens once');
    });

    it('without an agent or a reference, keeps the answer ungraded', () => {
      const { model } = make();
      model.answer('o-noref', undefined, 'The reduced rate');
      const a = answerOf(model, 'o-noref');
      assert.equal(a.done, true);
      assert.equal(a.attempts[0].verdict, 'noted');
    });

    it('ignores empty answers', () => {
      const { model } = make();
      model.answer('o-total', undefined, '   ');
      model.answer('o-total');
      assert.equal(answerOf(model, 'o-total'), undefined);
    });

    it('with an agent, asks it to grade, and a first wrong answer gets a hint and another try', () => {
      const { model } = make({ agentAvailable: true });
      assert.equal(model.needsAgentGrading('o-total'), true);
      assert.equal(model.needsAgentGrading('p-money'), false, 'multiple choice is graded locally');
      assert.deepEqual(model.answer('o-total', undefined, ' per line '), { kind: 'evaluate', questionId: 'o-total', attempt: 1, text: 'per line' });
      let a = answerOf(model, 'o-total');
      assert.equal(a.pending, true);
      assert.deepEqual(model.answer('o-total', undefined, 'again'), NO_EFFECT, 'one grading at a time');

      model.applyEvaluation('o-total', { verdict: 'incorrect', reply: 'What happens to rates that share a line?' });
      a = answerOf(model, 'o-total');
      assert.equal(a.pending, undefined);
      assert.equal(a.done, false);
      assert.deepEqual(a.attempts[0], { at: '2026-10-03T10:00:00.000Z', text: 'per line', verdict: 'incorrect', reply: 'What happens to rates that share a line?', by: 'agent' });

      assert.deepEqual(model.answer('o-total', undefined, 'per rate'), { kind: 'evaluate', questionId: 'o-total', attempt: 2, text: 'per rate' });
      model.applyEvaluation('o-total', { verdict: 'incorrect', reply: 'It is once per rate: …' });
      a = answerOf(model, 'o-total');
      assert.equal(a.done, true, 'the second wrong answer is explained and finished');
      assert.equal(model.answer('o-total', undefined, 'third'), NO_EFFECT);
    });

    it('finishes on correct or partly correct', () => {
      for (const verdict of ['correct', 'partly'] as const) {
        const { model } = make({ agentAvailable: true });
        model.answer('o-total', undefined, 'per rate');
        model.applyEvaluation('o-total', { verdict, reply: 'Yes.' });
        assert.equal(answerOf(model, 'o-total').done, true);
        assert.equal(answerOf(model, 'o-total').attempts[0].verdict, verdict);
      }
    });

    it('ignores stale or malformed evaluations', () => {
      const { model } = make({ agentAvailable: true });
      model.applyEvaluation('o-total', { verdict: 'correct', reply: 'Nobody asked.' });
      assert.equal(answerOf(model, 'o-total'), undefined);
      model.answer('o-total', undefined, 'per rate');
      model.applyEvaluation('o-total', { verdict: 'great' as 'correct', reply: 'x' });
      const a = answerOf(model, 'o-total');
      assert.equal(a.pending, undefined);
      assert.equal(a.awaitingSelfCheck, true, 'a malformed verdict falls back to the self-check');
    });

    it('drafts the comment an evaluation suggests, and a later one replaces it', () => {
      const { model } = make({ agentAvailable: true });
      model.answer('o-total', undefined, 'per line');
      model.applyEvaluation('o-total', { verdict: 'incorrect', reply: 'Hint?', comment: { severity: 'question', body: 'Is per-rate rounding agreed with finance?' } });
      assert.deepEqual(comments(model)[0].origin, { kind: 'question', questionId: 'o-total' });
      assert.equal(comments(model)[0].nodeId, 'invoice/Invoice.total');
      model.answer('o-total', undefined, 'per rate');
      model.applyEvaluation('o-total', { verdict: 'correct', reply: 'Yes.', comment: { severity: 'suggestion', body: 'Add a test for two rates.' } });
      assert.deepEqual(
        comments(model).map((c) => c.body),
        ['Add a test for two rates.'],
      );
    });

    it('falls back to a self-check when grading fails, or keeps the answer when there is no reference', () => {
      const { model } = make({ agentAvailable: true });
      model.answer('o-total', undefined, 'per rate');
      model.failEvaluation('o-total', 'Your Claude login has expired.');
      let a = answerOf(model, 'o-total');
      assert.equal(a.pending, undefined);
      assert.equal(a.awaitingSelfCheck, true);
      assert.equal(a.attempts[0].reply, 'Once per rate, not per line.');
      model.selfCheck('o-total', true);
      assert.equal(answerOf(model, 'o-total').done, true);

      model.answer('o-noref', undefined, 'reduced');
      model.failEvaluation('o-noref', 'Timed out.');
      a = answerOf(model, 'o-noref');
      assert.equal(a.done, true);
      assert.equal(a.attempts[0].verdict, 'noted');
      model.failEvaluation('o-noref', 'again');
      assert.equal(answerOf(model, 'o-noref').attempts.length, 1, 'stale failures are ignored');
    });

    it('stops asking the agent once it is unavailable', () => {
      const { model } = make({ agentAvailable: true });
      model.setAgentAvailable(false);
      assert.equal(model.snapshot().agentAvailable, false);
      assert.deepEqual(model.answer('o-total', undefined, 'per rate'), NO_EFFECT);
      assert.equal(answerOf(model, 'o-total').awaitingSelfCheck, true);
    });
  });

  describe('confidence', () => {
    it('is seeded from familiarity under the module path, and never overwrites a stored record', () => {
      const { model, store } = make();
      model.familiarity('money', 'new');
      assert.deepEqual(store.get('src/money'), { confidence: 0.2, lastTouched: '2026-10-03T10:00:00.000Z' });
      model.familiarity('money', 'known');
      assert.equal(store.get('src/money')!.confidence, 0.2);
      assert.equal(model.snapshot().territories[0].familiarity, 'known');
      model.familiarity('invoice', 'known');
      assert.equal(store.get('src/invoice')!.confidence, 0.8);
      model.familiarity('tax', 'some');
      assert.equal(store.get('src/tax')!.confidence, 0.5);
      assert.equal(model.snapshot().territories.find((t) => t.nodeId === 'tax')!.confidence, 0.5);
    });

    it('rejects familiarity for nodes that are not territories, and levels that are not levels', () => {
      const { model, store } = make();
      model.familiarity('money/roundToCents', 'known');
      model.familiarity('ext/checkout-web', 'known');
      model.familiarity('money', 'expert' as 'known');
      assert.deepEqual(store.toJSON(), {});
      assert.equal(model.snapshot().territories[0].familiarity, undefined);
    });

    it('moves with understand answers: +0.15 first try, +0.05 second, -0.10 wrong in the end', () => {
      const { model, store } = make({ confidence: new MemoryConfidenceStore({ 'src/money': { confidence: 0.5, lastTouched: '2026-01-01T00:00:00.000Z' } }) });
      model.answer('p-money', 'a');
      assert.equal(store.get('src/money')!.confidence, 0.65);
      assert.equal(store.get('src/money')!.lastTouched, '2026-10-03T10:00:01.000Z', 'the clock ticked once for the attempt');
      model.answer('c-multiply', 'a');
      assert.equal(store.get('src/money')!.confidence, 0.55);
      model.answer('o-checkout', undefined, 'cents move');
      model.selfCheck('o-checkout', true);
      assert.equal(store.get('src/money')!.confidence, 0.7, 'a question about a consumer counts for the territory it consumes');
    });

    it('counts a second-try success and a partly correct answer as +0.05', () => {
      const { model, store } = make({ agentAvailable: true, confidence: new MemoryConfidenceStore({ 'src/money': { confidence: 0.5, lastTouched: 'x' }, 'src/invoice': { confidence: 0.5, lastTouched: 'x' } }) });
      model.answer('p-money', 'b');
      model.answer('p-money', 'a');
      assert.equal(store.get('src/money')!.confidence, 0.55);
      model.answer('o-total', undefined, 'half');
      model.applyEvaluation('o-total', { verdict: 'partly', reply: 'Half right.' });
      assert.equal(store.get('src/invoice')!.confidence, 0.55);
    });

    it('does not move on the hint step, on judgements, or without a record', () => {
      const { model, store } = make({ confidence: new MemoryConfidenceStore({ 'src/money': { confidence: 0.5, lastTouched: 'x' } }) });
      model.answer('p-money', 'b');
      model.answer('j-round', 'block');
      assert.deepEqual(store.get('src/money'), { confidence: 0.5, lastTouched: 'x' });
      model.answer('p-invoice', 'c');
      assert.equal(store.get('src/invoice'), undefined, "no familiarity, no record: the model doesn't invent one");
    });

    it('stays within 0..1', () => {
      const { model, store } = make({ confidence: new MemoryConfidenceStore({ 'src/money': { confidence: 0.95, lastTouched: 'x' }, 'src/invoice': { confidence: 0.05, lastTouched: 'x' } }) });
      model.answer('p-money', 'a');
      assert.equal(store.get('src/money')!.confidence, 1);
      model.answer('p-invoice', 'a');
      model.answer('p-invoice', 'b');
      assert.equal(store.get('src/invoice')!.confidence, 0);
    });

    it('reports the module path a node’s confidence lives under', () => {
      const { model } = make();
      assert.equal(model.modulePathOf('money'), 'src/money');
      assert.equal(model.modulePathOf('money/roundToCents'), 'src/money');
      assert.equal(model.modulePathOf('ext/checkout-web'), 'src/money');
      assert.equal(model.modulePathOf('ext/mobile-app'), 'src/api');
    });
  });

  describe('didactic gate', () => {
    it('does nothing in fast mode', () => {
      const { model } = make();
      model.enter('money');
      assert.equal(model.snapshot().gate, undefined);
      assert.equal(model.select('money/roundToCents'), true, 'fast mode has no fog');
    });

    it('asks familiarity, then the territory’s first predict question; answering it explores the territory', () => {
      const { model, store } = make({ mode: 'didactic' });
      assert.equal(model.select('money'), false, 'a fogged territory opens no code');
      model.enter('money');
      assert.deepEqual(model.snapshot().gate, { nodeId: 'money', step: 'familiarity' });
      model.familiarity('money', 'some');
      assert.deepEqual(model.snapshot().gate, { nodeId: 'money', step: 'predict', questionId: 'p-money' });
      assert.equal(store.get('src/money')!.confidence, 0.5);

      model.answer('p-money', 'b');
      let s = model.snapshot();
      assert.equal(s.territories[0].explored, false, 'a hinted wrong answer is not done yet');
      assert.equal(s.gate?.questionId, 'p-money');
      model.answer('p-money', 'a');
      s = model.snapshot();
      assert.equal(s.territories[0].explored, true);
      assert.deepEqual(s.coverage, { explored: 1, total: 4 });
      assert.deepEqual(s.gate, { nodeId: 'money', step: 'predict', questionId: 'p-money' }, 'the feedback stays visible');
      assert.equal(store.get('src/money')!.confidence, 0.55);

      assert.equal(model.select('money'), true, '"Continue into money"');
      assert.equal(model.snapshot().gate, undefined);
      assert.equal(model.select('money/roundToCents'), true);
    });

    it('skips familiarity when a confidence record exists for the module path', () => {
      const { model } = make({ mode: 'didactic', confidence: new MemoryConfidenceStore({ 'src/invoice': { confidence: 0.7, lastTouched: 'x' } }) });
      model.enter('invoice');
      assert.deepEqual(model.snapshot().gate, { nodeId: 'invoice', step: 'predict', questionId: 'p-invoice' });
      assert.equal(model.snapshot().territories.find((t) => t.nodeId === 'invoice')!.familiarity, undefined);
    });

    it('locks questions in fog, except the gate question while its gate is open', () => {
      const { model } = make({ mode: 'didactic' });
      assert.equal(model.answer('p-money', 'a'), NO_EFFECT);
      assert.equal(model.answer('j-round', 'block'), NO_EFFECT);
      assert.deepEqual(model.snapshot().answers, {});
      model.enter('money');
      model.answer('p-money', 'a');
      assert.deepEqual(model.snapshot().answers, {}, 'not before the familiarity step');
      model.familiarity('money', 'new');
      model.answer('j-round', 'block');
      assert.deepEqual(model.snapshot().answers, {}, 'only the gate question');
      model.answer('p-money', 'a');
      model.answer('j-round', 'block');
      assert.equal(answerOf(model, 'j-round').done, true, 'inside an explored territory, its questions open');
    });

    it('locks externals until a territory they are linked to is explored', () => {
      const { model } = make({ mode: 'didactic' });
      assert.equal(model.select('ext/checkout-web'), false);
      model.answer('o-checkout', undefined, 'early');
      assert.equal(answerOf(model, 'o-checkout'), undefined);
      explore(model, 'money', { choiceId: 'a' });
      assert.equal(model.select('ext/checkout-web'), true);
      assert.equal(model.select('ext/mobile-app'), false, 'mobile-app consumes api, still fogged');
      model.answer('o-checkout', undefined, 'cents move');
      assert.equal(answerOf(model, 'o-checkout').awaitingSelfCheck, true);
    });

    it('uses a descendant’s predict question when the module has none of its own', () => {
      const { model } = make({ mode: 'didactic' });
      model.enter('api');
      model.familiarity('api', 'known');
      assert.equal(model.snapshot().gate?.questionId, 'p-api');
    });

    it('picks the first predict question at the chosen depth', () => {
      const { model } = make({ mode: 'didactic' });
      model.setDepth('deep');
      model.enter('invoice');
      model.familiarity('invoice', 'known');
      assert.equal(model.snapshot().gate?.questionId, 'p-invoice', 'the module before its riskier-than-nothing descendant');
    });

    it('asks a synthetic open prediction where there is no predict question, and never grades it', () => {
      const { model } = make({ mode: 'didactic', agentAvailable: true });
      const gateId = gateQuestionId('tax');
      assert.ok(ids(model).includes(gateId), 'listed while tax is fogged');
      model.enter('tax');
      model.familiarity('tax', 'new');
      assert.deepEqual(model.snapshot().gate, { nodeId: 'tax', step: 'predict', questionId: gateId });
      const q = model.snapshot().questions.find((x) => x.id === gateId)!;
      assert.deepEqual(q, { id: 'gate:tax', nodeId: 'tax', stage: 'predict', purpose: 'judge', depth: 'skim', prompt: 'What do you expect this change to affect in tax?' });
      assert.equal(model.needsAgentGrading(gateId), false);
      assert.deepEqual(model.answer(gateId, undefined, 'VAT on ebooks'), NO_EFFECT);
      const a = answerOf(model, gateId);
      assert.deepEqual(a.attempts[0], { at: '2026-10-03T10:00:01.000Z', text: 'VAT on ebooks', verdict: 'noted', reply: NOTED_PREDICTION_REPLY, by: 'self' });
      assert.equal(a.done, true);
      assert.equal(model.snapshot().territories.find((t) => t.nodeId === 'tax')!.explored, true);
      assert.equal(model.answer(gateId, undefined, 'again'), NO_EFFECT, 'a prediction is made once');
      model.select('tax');
      model.setMode('fast');
      assert.ok(ids(model).includes(gateId), 'the prediction stays visible after switching to fast');
    });

    it('lists synthetic gates only in didactic mode, for fogged territories', () => {
      const { model } = make({ mode: 'didactic' });
      model.setDepth('skim');
      assert.deepEqual(ids(model), ['p-money', 'j-round', 'gate:invoice', 'gate:api', 'gate:tax']);
      model.setMode('fast');
      assert.deepEqual(ids(model), ['p-money', 'j-round']);
      assert.equal(model.answer('gate:invoice', undefined, 'x'), NO_EFFECT, 'gates are not answerable in fast mode');
    });

    it('waits for the questions while they are loading, then asks the real predict question', () => {
      const { model } = make({ mode: 'didactic', questions: undefined, questionsStatus: { state: 'loading' } });
      assert.deepEqual(ids(model), [], 'no synthetic gates while loading');
      model.enter('money');
      model.familiarity('money', 'some');
      assert.deepEqual(model.snapshot().gate, { nodeId: 'money', step: 'predict' });
      model.setQuestions(questions(), { state: 'ready' });
      assert.deepEqual(model.snapshot().gate, { nodeId: 'money', step: 'predict', questionId: 'p-money' });
    });

    it('falls back to synthetic gates when the questions fail', () => {
      const { model } = make({ mode: 'didactic', questions: undefined, questionsStatus: { state: 'loading' } });
      model.enter('money');
      model.familiarity('money', 'some');
      model.setQuestions(undefined, { state: 'error', message: 'The agent timed out.' });
      const s = model.snapshot();
      assert.deepEqual(s.gate, { nodeId: 'money', step: 'predict', questionId: 'gate:money' });
      assert.deepEqual(s.questionsStatus, { state: 'error', message: 'The agent timed out.' });
    });

    it('explores the territory when an agent-graded prediction finishes after the gate closed', () => {
      const set = questions();
      set.questions.push({ id: 'p-tax-open', nodeId: 'tax', stage: 'predict', purpose: 'understand', depth: 'standard', prompt: 'What will ebooks pay?', reference: 'The reduced rate.' });
      const { model } = make({ mode: 'didactic', agentAvailable: true, questions: set });
      model.enter('tax');
      model.familiarity('tax', 'some');
      assert.equal(model.snapshot().gate?.questionId, 'p-tax-open');
      assert.deepEqual(model.answer('p-tax-open', undefined, 'reduced'), { kind: 'evaluate', questionId: 'p-tax-open', attempt: 1, text: 'reduced' });
      model.cancelGate();
      model.applyEvaluation('p-tax-open', { verdict: 'correct', reply: 'Yes.' });
      assert.equal(model.snapshot().territories.find((t) => t.nodeId === 'tax')!.explored, true);
    });

    it('lets a prediction made in fast mode open the territory at once', () => {
      const { model } = make();
      model.answer('p-money', 'a');
      model.setMode('didactic');
      model.enter('money');
      assert.equal(model.snapshot().territories[0].explored, false, 'familiarity is still asked');
      model.familiarity('money', 'known');
      assert.equal(model.snapshot().territories[0].explored, true);
      assert.equal(model.snapshot().gate?.questionId, 'p-money');
    });

    it('cancels, switches territory, and closes when leaving didactic mode', () => {
      const { model } = make({ mode: 'didactic' });
      model.enter('money');
      model.cancelGate();
      assert.equal(model.snapshot().gate, undefined);
      model.enter('money');
      model.enter('invoice');
      assert.equal(model.snapshot().gate?.nodeId, 'invoice');
      model.setMode('fast');
      assert.equal(model.snapshot().gate, undefined);
      assert.equal(model.snapshot().mode, 'fast');
    });

    it('ignores enter for non-territories and explored territories', () => {
      const { model } = make({ mode: 'didactic' });
      model.enter('money/roundToCents');
      model.enter('ext/checkout-web');
      model.enter('nowhere');
      assert.equal(model.snapshot().gate, undefined);
      explore(model, 'money', { choiceId: 'a' });
      model.enter('money');
      assert.equal(model.snapshot().gate, undefined);
    });

    it('keeps the gate open when a fogged node is selected, and closes it for a visible one', () => {
      const { model } = make({ mode: 'didactic' });
      explore(model, 'money', { choiceId: 'a' });
      model.enter('invoice');
      assert.equal(model.select('invoice/Invoice.total'), false);
      assert.equal(model.snapshot().gate?.nodeId, 'invoice');
      assert.equal(model.select('nowhere'), false);
      assert.equal(model.select('money/Money.multiply'), true);
      assert.equal(model.snapshot().gate, undefined);
    });
  });

  describe('comments', () => {
    it('accepts, rejects and reopens', () => {
      const { model } = make();
      model.answer('j-round', 'block');
      model.commentAction('c1', 'accept');
      assert.equal(comments(model)[0].status, 'accepted');
      model.commentAction('c1', 'reject');
      assert.equal(comments(model)[0].status, 'rejected');
      model.commentAction('c1', 'reopen');
      assert.equal(comments(model)[0].status, 'draft');
      model.commentAction('c1', 'delete' as 'accept');
      model.commentAction('c9', 'accept');
      assert.equal(comments(model)[0].status, 'draft');
    });

    it('amends the body and marks it amended, ignoring empty or unchanged text', () => {
      const { model } = make();
      model.answer('j-round', 'block');
      model.amend('c1', '   ');
      model.amend('c1', 'Please keep half-up as the default.');
      assert.equal(comments(model)[0].amended, false);
      model.amend('c1', '  Keep half-up, please.  ');
      assert.equal(comments(model)[0].body, 'Keep half-up, please.');
      assert.equal(comments(model)[0].amended, true);
    });

    it('turns a note into a draft, anchored at a symbol’s first line', () => {
      const { model } = make();
      model.addNote(' Rename this. ', 'money/roundToCents');
      model.addNote('The module needs a README.', 'money');
      model.addNote('Thanks for the clear PR.');
      model.addNote('Unknown node.', 'nowhere');
      model.addNote('   ');
      assert.deepEqual(comments(model), [
        { id: 'c1', nodeId: 'money/roundToCents', file: 'src/money/round.ts', line: 18, body: 'Rename this.', severity: 'suggestion', origin: { kind: 'note' }, status: 'draft', amended: false, thread: [] },
        { id: 'c2', nodeId: 'money', body: 'The module needs a README.', severity: 'suggestion', origin: { kind: 'note' }, status: 'draft', amended: false, thread: [] },
        { id: 'c3', body: 'Thanks for the clear PR.', severity: 'suggestion', origin: { kind: 'note' }, status: 'draft', amended: false, thread: [] },
        { id: 'c4', body: 'Unknown node.', severity: 'suggestion', origin: { kind: 'note' }, status: 'draft', amended: false, thread: [] },
      ]);
    });

    it('needs the agent for threads', () => {
      const { model } = make();
      model.addNote('A note.');
      assert.deepEqual(model.thread('c1', 'Can you sharpen this?'), NO_EFFECT);
      assert.deepEqual(comments(model)[0].thread, []);
    });

    it('runs a thread: the reviewer writes, the agent replies with a proposal, the reviewer adopts it', () => {
      const { model } = make({ agentAvailable: true });
      model.answer('j-round', 'ask');
      assert.deepEqual(model.thread('c1', '  Add the numbers.  '), { kind: 'thread', commentId: 'c1' });
      assert.equal(comments(model)[0].threadPending, true);
      assert.deepEqual(model.thread('c1', 'And another thing'), NO_EFFECT, 'one reply at a time');
      assert.deepEqual(model.thread('c1', '  '), NO_EFFECT);
      assert.deepEqual(model.thread('c9', 'x'), NO_EFFECT);

      model.applyThreadReply('c1', { reply: 'Here is a version with numbers.', proposal: ' 12.5 cents now rounds to 12. Intended? ' });
      let c = comments(model)[0];
      assert.equal(c.threadPending, undefined);
      assert.deepEqual(c.thread, [
        { role: 'user', text: 'Add the numbers.' },
        { role: 'agent', text: 'Here is a version with numbers.', proposal: '12.5 cents now rounds to 12. Intended?' },
      ]);
      model.applyThreadReply('c1', { reply: 'Stale.' });
      assert.equal(comments(model)[0].thread.length, 2, 'replies nobody waits for are dropped');

      model.adoptProposal('c1', 0);
      model.adoptProposal('c1', 5);
      assert.equal(comments(model)[0].amended, false, 'only an agent message with a proposal can be adopted');
      model.adoptProposal('c1', 1);
      c = comments(model)[0];
      assert.equal(c.body, '12.5 cents now rounds to 12. Intended?');
      assert.equal(c.amended, true);
    });

    it('shows a failed thread reply as the agent’s turn', () => {
      const { model } = make({ agentAvailable: true });
      model.addNote('A note.');
      model.thread('c1', 'Shorter?');
      model.failThread('c1', 'The agent is not logged in.');
      const c = comments(model)[0];
      assert.equal(c.threadPending, undefined);
      assert.deepEqual(c.thread[1], { role: 'agent', text: 'The agent is not logged in.' });
    });

    it('drafts with the agent: new comments only, cleaned', () => {
      const { model } = make();
      assert.deepEqual(model.draftWithAgent(), NO_EFFECT, 'needs the agent');
      const withAgent = make({ agentAvailable: true }).model;
      withAgent.answer('j-round', 'block');
      assert.deepEqual(withAgent.draftWithAgent(), { kind: 'draft' });
      assert.equal(withAgent.snapshot().draftingPending, true);
      assert.deepEqual(withAgent.draftWithAgent(), NO_EFFECT, 'one drafting pass at a time');
      withAgent.applyAgentDrafts([
        { nodeId: 'invoice/applyDiscount', file: 'src/invoice/discount.ts', line: 23, severity: 'blocking', body: ' Add unit tests for applyDiscount. ' },
        { file: 'src/money/round.ts', line: 18, severity: 'blocking', body: 'Please keep half-up as the default.' },
        { nodeId: 'nowhere', severity: 'loud' as 'nit', body: 'Typo in the docstring.' },
        { file: 'src/tax/vat.ts', line: 0, severity: 'nit', body: 'Line zero is no line.' },
        { severity: 'nit', body: '   ' },
        { severity: 'nit', body: 'Typo in the docstring.' },
      ]);
      const s = withAgent.snapshot();
      assert.equal(s.draftingPending, undefined);
      assert.deepEqual(
        s.comments.map((c) => ({ id: c.id, nodeId: c.nodeId, file: c.file, line: c.line, severity: c.severity, body: c.body, origin: c.origin.kind })),
        [
          { id: 'c1', nodeId: 'money/roundToCents', file: 'src/money/round.ts', line: 18, severity: 'blocking', body: 'Please keep half-up as the default.', origin: 'question' },
          { id: 'c2', nodeId: 'invoice/applyDiscount', file: 'src/invoice/discount.ts', line: 23, severity: 'blocking', body: 'Add unit tests for applyDiscount.', origin: 'agent' },
          { id: 'c3', nodeId: undefined, file: undefined, line: undefined, severity: 'suggestion', body: 'Typo in the docstring.', origin: 'agent' },
          { id: 'c4', nodeId: undefined, file: 'src/tax/vat.ts', line: undefined, severity: 'nit', body: 'Line zero is no line.', origin: 'agent' },
        ],
      );
    });

    it('clears drafting when it fails', () => {
      const { model } = make({ agentAvailable: true });
      model.draftWithAgent();
      model.failDrafting('Budget reached.');
      assert.equal(model.snapshot().draftingPending, undefined);
      assert.deepEqual(model.draftWithAgent(), { kind: 'draft' });
    });
  });

  describe('posting', () => {
    it('offers export, not posting, when there is no pull request', () => {
      const { model } = make();
      model.answer('j-round', 'block');
      model.commentAction('c1', 'accept');
      assert.deepEqual(model.requestPost(), NO_EFFECT);
      assert.deepEqual(model.apply({ type: 'post' }), NO_EFFECT);
      assert.deepEqual(model.apply({ type: 'exportReview' }), { kind: 'export' });
    });

    it('posts accepted comments once: a later post sends only the new ones', () => {
      const { model } = make({ post: GITHUB });
      model.answer('j-round', 'block');
      model.addNote('Nice tests.');
      model.addNote('Draft only.');
      model.commentAction('c1', 'accept');
      model.commentAction('c2', 'accept');
      const effect = model.requestPost();
      assert.equal(effect.kind, 'post');
      assert.deepEqual(effect.kind === 'post' && effect.comments.map((c) => c.id), ['c1', 'c2']);

      model.setPostState({ target: GITHUB, status: 'posting' });
      assert.deepEqual(model.requestPost(), NO_EFFECT, 'no second post while one is running');
      model.setPostState({ target: GITHUB, status: 'posted', url: 'https://github.com/acme/ledger/pull/7#pullrequestreview-1' });
      assert.deepEqual(model.snapshot().post, { target: GITHUB, status: 'posted', url: 'https://github.com/acme/ledger/pull/7#pullrequestreview-1' });
      assert.equal(model.isPosted('c1'), true);
      assert.equal(model.isPosted('c3'), false);
      // The snapshot flags them, so the webview can say so (and not offer them again) after a reload.
      assert.deepEqual(model.snapshot().comments.map((c) => [c.id, c.posted ?? false]), [['c1', true], ['c2', true], ['c3', false]]);
      assert.ok(model.persisted().comments.every((c) => !('posted' in c)), 'posted is kept as ids, not on the comments');

      const again = model.requestPost();
      assert.deepEqual(again.kind === 'post' && again.comments, [], 'nothing new to post');
      model.commentAction('c3', 'accept');
      const third = model.requestPost();
      assert.deepEqual(third.kind === 'post' && third.comments.map((c) => c.id), ['c3']);
    });

    it('marks nothing posted when posting fails or is cancelled', () => {
      const { model } = make({ post: GITHUB });
      model.addNote('A note.');
      model.commentAction('c1', 'accept');
      model.requestPost();
      model.setPostState({ target: GITHUB, status: 'error', error: 'HTTP 422' });
      assert.equal(model.isPosted('c1'), false);
      model.requestPost();
      model.setPostState({ target: GITHUB, status: 'idle' });
      model.setPostState({ target: GITHUB, status: 'posted' });
      assert.equal(model.isPosted('c1'), false, 'a stray "posted" after a cancel marks nothing');
    });
  });

  describe('apply', () => {
    it('dispatches every webview action to its method', () => {
      const { model } = make({ mode: 'fast', agentAvailable: true });
      assert.deepEqual(model.apply({ type: 'setMode', mode: 'didactic' }), NO_EFFECT);
      model.apply({ type: 'setDepth', depth: 'deep' });
      model.apply({ type: 'enter', nodeId: 'money' });
      model.apply({ type: 'familiarity', nodeId: 'money', level: 'known' });
      model.apply({ type: 'answer', questionId: 'p-money', choiceId: 'a' });
      model.apply({ type: 'answer', questionId: 'j-round', choiceId: 'ask' });
      assert.deepEqual(model.apply({ type: 'answer', questionId: 'o-checkout', text: 'cents' }), { kind: 'evaluate', questionId: 'o-checkout', attempt: 1, text: 'cents' });
      model.apply({ type: 'cancelGate' });
      model.apply({ type: 'commentAction', id: 'c1', action: 'accept' });
      model.apply({ type: 'amend', id: 'c1', body: 'Sharper.' });
      assert.deepEqual(model.apply({ type: 'thread', id: 'c1', text: 'Why?' }), { kind: 'thread', commentId: 'c1' });
      model.applyThreadReply('c1', { reply: 'Because.', proposal: 'Sharpest.' });
      model.apply({ type: 'adoptProposal', id: 'c1', index: 1 });
      model.apply({ type: 'addNote', text: 'Note.', nodeId: 'tax' });
      assert.deepEqual(model.apply({ type: 'draftWithAgent' }), { kind: 'draft' });
      assert.deepEqual(model.apply({ type: 'unknown' } as never), NO_EFFECT);

      const s = model.snapshot();
      assert.equal(s.mode, 'didactic');
      assert.equal(s.depth.chosen, 'deep');
      assert.equal(s.territories[0].explored, true);
      assert.equal(s.gate, undefined);
      assert.deepEqual(
        s.comments.map((c) => [c.id, c.status, c.body]),
        [
          ['c1', 'accepted', 'Sharpest.'],
          ['c2', 'draft', 'Note.'],
        ],
      );

      const selfChecked = make().model;
      selfChecked.apply({ type: 'answer', questionId: 'o-total', text: 'per rate' });
      selfChecked.apply({ type: 'selfCheck', questionId: 'o-total', gotIt: true });
      assert.equal(selfChecked.snapshot().answers['o-total'].attempts[0].verdict, 'correct');
    });
  });

  describe('questions arriving later', () => {
    it('keeps answers by question id and drops reserved or repeated ids', () => {
      const { model } = make();
      model.answer('p-money', 'a');
      const next = questions();
      next.questions.push({ ...next.questions[0], id: 'gate:money' }, { ...next.questions[1] });
      model.setQuestions(next, { state: 'ready' });
      assert.equal(answerOf(model, 'p-money').done, true);
      assert.equal(ids(model).filter((id) => id === 'j-round').length, 1);
      assert.ok(!ids(model).includes('gate:money'));
    });

    it('drops questions about nodes the graph does not have', () => {
      const set = questions();
      set.questions.push({ ...set.questions[0], id: 'ghost', nodeId: 'ghost' });
      const { model } = make({ questions: set });
      assert.ok(!ids(model).includes('ghost'));
      assert.equal(model.answer('ghost', 'a'), NO_EFFECT);
    });
  });

  describe('persistence', () => {
    function busyModel(): ReviewModel {
      const { model } = make({ mode: 'didactic', agentAvailable: true, post: GITHUB, confidence: new MemoryConfidenceStore() });
      model.setDepth('deep');
      explore(model, 'money', { choiceId: 'a' });
      model.answer('j-round', 'block');
      model.commentAction('c1', 'accept');
      model.requestPost();
      model.setPostState({ target: GITHUB, status: 'posted' });
      model.addNote('Second thoughts.');
      model.thread('c2', 'Help?'); // in flight: not persisted
      model.answer('o-checkout', undefined, 'cents'); // grading in flight: not persisted
      model.enter('invoice');
      model.familiarity('invoice', 'new');
      return model;
    }

    it('keeps chosen depth, answers, comments, explored territories, familiarity and posted ids, and nothing in flight', () => {
      const p = busyModel().persisted();
      assert.equal(p.version, 1);
      assert.equal(p.chosenDepth, 'deep');
      assert.deepEqual(Object.keys(p.answers).sort(), ['j-round', 'p-money']);
      assert.deepEqual(p.explored, ['money']);
      assert.deepEqual(p.familiarity, { money: 'some', invoice: 'new' });
      assert.deepEqual(p.posted, ['c1']);
      assert.deepEqual(
        p.comments.map((c) => [c.id, c.status, c.threadPending]),
        [
          ['c1', 'accepted', undefined],
          ['c2', 'draft', undefined],
        ],
      );
      assert.deepEqual(p.comments[1].thread, [{ role: 'user', text: 'Help?' }]);
      assert.deepEqual(JSON.parse(JSON.stringify(p)), p, 'plain JSON');
      assert.ok(!('confidence' in p), 'confidence is global, not per PR');
    });

    it('restores into a model that carries on where it left off', () => {
      const saved = JSON.parse(JSON.stringify(busyModel().persisted()));
      const { model } = make({ mode: 'didactic', agentAvailable: true, post: GITHUB, persisted: saved });
      const s = model.snapshot();
      assert.equal(s.depth.chosen, 'deep');
      assert.deepEqual(s.coverage, { explored: 1, total: 4 });
      assert.equal(s.territories.find((t) => t.nodeId === 'invoice')!.familiarity, 'new');
      assert.equal(s.answers['o-checkout'], undefined, 'the answer being graded is gone, so it can be answered again');
      assert.equal(model.isPosted('c1'), true);
      model.addNote('Third.');
      assert.deepEqual(
        model.snapshot().comments.map((c) => c.id),
        ['c1', 'c2', 'c3'],
        'new ids continue after the restored ones',
      );
      const post = model.requestPost();
      assert.deepEqual(post.kind === 'post' && post.comments, [], 'c1 is not posted twice after a reload');
    });

    it('reads stored state defensively', () => {
      assert.equal(parsePersistedReview(undefined), undefined);
      assert.equal(parsePersistedReview({ version: 2 }), undefined);
      assert.equal(parsePersistedReview([]), undefined);
      const p = parsePersistedReview({
        version: 1,
        chosenDepth: 'bottomless',
        answers: {
          ok: { attempts: [{ at: 't', verdict: 'correct', reply: 'r', by: 'choice', choiceId: 'a' }], done: true },
          badVerdict: { attempts: [{ at: 't', verdict: 'great', reply: 'r', by: 'choice' }], done: true },
          empty: { attempts: [], done: true },
          inFlight: { attempts: [{ at: 't', verdict: 'noted', reply: '', by: 'agent', text: 'x' }], done: false, pending: true },
          waiting: { attempts: [{ at: 't', verdict: 'noted', reply: 'ref', by: 'self', text: 'x' }], done: false, awaitingSelfCheck: true },
          ['__proto__']: { attempts: [{ at: 't', verdict: 'noted', reply: '', by: 'self' }], done: true },
        },
        comments: [
          { id: 'c1', body: 'b', severity: 'nit', status: 'draft', origin: { kind: 'note' }, thread: [{ role: 'agent', text: 'hi', proposal: 'p' }, { role: 'system', text: 'x' }], line: 0, file: 'a.ts' },
          { id: 'c1', body: 'duplicate id', severity: 'nit', status: 'draft', origin: { kind: 'note' } },
          { id: 'c2', body: 'b', severity: 'urgent', status: 'draft', origin: { kind: 'note' } },
          { id: 'c3', body: 'b', severity: 'nit', status: 'posted', origin: { kind: 'note' } },
          { id: 'c4', body: 'b', severity: 'nit', status: 'draft', origin: { kind: 'telepathy' } },
        ],
        explored: ['money', 7, 'money'],
        familiarity: { money: 'known', tax: 'expert' },
        posted: ['c1', 'c9', 3],
      })!;
      assert.equal(p.chosenDepth, undefined);
      assert.deepEqual(Object.keys(p.answers).sort(), ['__proto__', 'ok', 'waiting']);
      assert.equal(Object.getPrototypeOf(p.answers), Object.prototype, '"__proto__" stays an ordinary key');
      assert.equal(p.answers.waiting.awaitingSelfCheck, true);
      assert.deepEqual(p.comments, [{ id: 'c1', body: 'b', severity: 'nit', status: 'draft', origin: { kind: 'note' }, amended: false, thread: [{ role: 'agent', text: 'hi', proposal: 'p' }], file: 'a.ts' }]);
      assert.deepEqual(p.explored, ['money']);
      assert.deepEqual(p.familiarity, { money: 'known' });
      assert.deepEqual(p.posted, ['c1']);
    });

    it('ignores restored territories and familiarity for nodes the graph no longer has', () => {
      const { model } = make({ mode: 'didactic', persisted: { version: 1, answers: {}, comments: [], explored: ['money', 'gone'], familiarity: { gone: 'known', 'money/roundToCents': 'new' } } });
      const s = model.snapshot();
      assert.deepEqual(s.coverage, { explored: 1, total: 4 });
      assert.ok(s.territories.every((t) => t.familiarity === undefined));
    });
  });
});

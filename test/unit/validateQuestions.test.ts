import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { toCliSchema } from '../../src/agent/schema';
import type { ReviewGraph } from '../../src/contract/graph';
import { DEPTHS, type Choice, type CommentSeed, type Question, type QuestionSet } from '../../src/contract/questions';
import { QUESTION_SET_SCHEMA, validateQuestionSet } from '../../src/contract/validateQuestions';

const FIXTURES = resolve(__dirname, '../../fixtures');
const HEAD = join(FIXTURES, 'sample-repo/head');
const graph = JSON.parse(readFileSync(join(FIXTURES, 'sample-graph.json'), 'utf8')) as ReviewGraph;

function readHead(path: string): string | undefined {
  try {
    return readFileSync(join(HEAD, path), 'utf8');
  } catch {
    return undefined;
  }
}

/** A fresh copy of the bundled sample's questions, safe to mutate. */
function sampleQuestions(): QuestionSet {
  return JSON.parse(readFileSync(join(FIXTURES, 'sample-questions.json'), 'utf8')) as QuestionSet;
}

const opts = { readFile: readHead };
const repairOpts = { readFile: readHead, repair: true };

const mc = (over: Partial<Question> = {}): Question => ({
  id: 'q1',
  nodeId: 'money',
  stage: 'predict',
  purpose: 'understand',
  depth: 'skim',
  prompt: 'What happens?',
  hint: 'What does the default do?',
  choices: [
    { id: 'a', text: 'This', correct: true, explain: 'Because.' },
    { id: 'b', text: 'That', explain: 'Not because.' },
  ],
  ...over,
});

const seed = (over: Partial<CommentSeed> = {}): CommentSeed => ({ file: 'src/money/round.ts', line: 18, body: 'Please keep half-up.', severity: 'blocking', ...over });

const judge = (over: Partial<Question> = {}, comment: CommentSeed = seed()): Question => ({
  id: 'j1',
  nodeId: 'money/roundToCents',
  stage: 'check',
  purpose: 'judge',
  depth: 'skim',
  prompt: 'What should the review say?',
  choices: [
    { id: 'fine', text: 'Fine as is', explain: 'Then nothing is said.' },
    { id: 'change', text: 'Ask for a change', explain: 'Drafts a comment.', comment },
  ],
  ...over,
});

const open = (over: Partial<Question> = {}): Question => ({
  id: 'o1',
  nodeId: 'invoice/Invoice.total',
  stage: 'check',
  purpose: 'understand',
  depth: 'skim',
  prompt: 'Explain the grouping.',
  reference: 'Grouped by category, not rate.',
  ...over,
});

const set = (...questions: Question[]): QuestionSet => ({ contractVersion: '0.1', depth: { proposed: 'skim', why: 'Small PR.' }, questions });

function errorsOf(input: unknown, o: Parameters<typeof validateQuestionSet>[2] = opts): string[] {
  const r = validateQuestionSet(input, graph, o);
  assert.equal(r.ok, false, 'expected validation to fail');
  return r.ok ? [] : r.errors;
}

function valid(input: unknown, o: Parameters<typeof validateQuestionSet>[2] = opts): { value: QuestionSet; warnings: string[] } {
  const r = validateQuestionSet(input, graph, o);
  assert.ok(r.ok, r.ok ? '' : r.errors.join('\n'));
  return r;
}

const choice = (q: Question, id: string): Choice => q.choices!.find((c) => c.id === id)!;
const atDepth = (s: QuestionSet, depth: (typeof DEPTHS)[number]) => s.questions.filter((q) => DEPTHS.indexOf(q.depth) <= DEPTHS.indexOf(depth));

/** Head-revision lines the sample PR adds or changes, per repo-relative path. */
function changedLines(): Map<string, Set<number>> {
  const out = spawnSync('git', ['diff', '--no-index', '--no-ext-diff', '--no-color', '--src-prefix=a/', '--dst-prefix=b/', '-U0', 'base', 'head'], { cwd: join(FIXTURES, 'sample-repo'), encoding: 'utf8' });
  assert.equal(out.status, 1, `git diff --no-index should report differences: ${out.stderr}`);
  const changed = new Map<string, Set<number>>();
  let lines: Set<number> | undefined;
  for (const l of out.stdout.split('\n')) {
    const file = /^\+\+\+ b\/head\/(.+)$/.exec(l);
    if (file) changed.set(file[1], (lines = new Set()));
    const hunk = /^@@ -\S+ \+(\d+)(?:,(\d+))? @@/.exec(l);
    if (hunk && lines) {
      const start = Number(hunk[1]);
      const count = hunk[2] === undefined ? 1 : Number(hunk[2]);
      for (let i = start; i < start + count; i++) lines.add(i);
    }
  }
  return changed;
}

describe('validateQuestionSet', () => {
  describe('the sample questions', () => {
    it('pass strictly with no warnings', () => {
      const r = valid(sampleQuestions());
      assert.deepEqual(r.warnings, []);
      assert.equal(r.value.questions.length, 14);
    });

    it('give every module a predict question on the module itself, and ask about an external', () => {
      const s = sampleQuestions();
      for (const m of graph.nodes.filter((n) => n.kind === 'module')) {
        const predicts = s.questions.filter((q) => q.nodeId === m.id && q.stage === 'predict');
        assert.equal(predicts.length, 1, `module ${m.id}`);
        assert.ok(predicts[0].choices, `module ${m.id}'s predict question is multiple choice`);
        const inside = s.questions.filter((q) => q.stage === 'check' && q.purpose === 'understand' && q.choices && q.nodeId.startsWith(`${m.id}/`));
        assert.ok(inside.length >= 1, `module ${m.id} has a multiple-choice check question`);
      }
      const externals = new Set(graph.nodes.filter((n) => n.kind === 'external').map((n) => n.id));
      assert.ok(s.questions.some((q) => externals.has(q.nodeId)));
    });

    it('nest depths: skim has the 4 most important, standard 12, deep all 14; standard is proposed', () => {
      const s = sampleQuestions();
      assert.equal(s.depth.proposed, 'standard');
      assert.deepEqual(atDepth(s, 'skim').map((q) => q.id), ['q-money-predict', 'q-round-default', 'q-total-tests', 'q-discount-tests']);
      assert.equal(atDepth(s, 'standard').length, 12);
      assert.equal(atDepth(s, 'deep').length, 14);
    });

    it('have two open questions, each with a reference', () => {
      const openQs = sampleQuestions().questions.filter((q) => !q.choices);
      assert.equal(openQs.length, 2);
      for (const q of openQs) assert.ok(q.reference && q.reference.length > 100, q.id);
    });

    it('give each judge question one "fine as is" choice and anchor every other choice\'s comment', () => {
      const judges = sampleQuestions().questions.filter((q) => q.purpose === 'judge');
      assert.equal(judges.length, 4);
      for (const q of judges) {
        assert.equal(q.hint, undefined, `${q.id}: judge questions are never wrong, so a hint is never shown`);
        const withoutComment = q.choices!.filter((c) => !c.comment);
        assert.equal(withoutComment.length, 1, q.id);
        for (const c of q.choices!.filter((c) => c.comment)) {
          assert.ok(c.comment!.file && c.comment!.line, `${q.id}/${c.id} is anchored`);
        }
      }
    });

    it('anchor comments on lines the PR changes, so they post inline', () => {
      const changed = changedLines();
      const seeds = sampleQuestions().questions.flatMap((q) => (q.choices ?? []).flatMap((c) => (c.comment ? [{ at: `${q.id}/${c.id}`, ...c.comment }] : [])));
      assert.ok(seeds.length >= 7);
      for (const s of seeds) assert.ok(changed.get(s.file!)?.has(s.line!), `${s.at}: ${s.file}:${s.line} is not a changed line`);
    });

    it('hint with a question, never the answer, on every understand question', () => {
      for (const q of sampleQuestions().questions.filter((q) => q.purpose === 'understand')) {
        assert.ok(q.hint?.trim().endsWith('?'), `${q.id} hint should be a question`);
      }
    });
  });

  describe('schema', () => {
    it('rejects a missing required field', () => {
      const s: Record<string, unknown> = { ...set(mc()) };
      delete s.depth;
      assert.match(errorsOf(s).join('\n'), /depth/);
    });

    it('rejects the wrong contract version', () => {
      const s = set(mc()) as unknown as { contractVersion: string };
      s.contractVersion = '0.2';
      assert.match(errorsOf(s).join('\n'), /contractVersion .*allowed values: 0\.1/);
    });

    it('rejects an unknown stage, listing the allowed values', () => {
      const s = set(mc({ stage: 'review' as Question['stage'] }));
      assert.match(errorsOf(s).join('\n'), /\/questions\/0\/stage .*allowed values: predict, check/);
    });

    it('rejects properties outside the contract', () => {
      const s = set(mc()) as unknown as { questions: Record<string, unknown>[] };
      s.questions[0].points = 10;
      assert.match(errorsOf(s).join('\n'), /additional properties/);
    });

    it('rejects a comment line below 1 and an unknown severity', () => {
      const s = set(judge({}, seed({ line: 0, severity: 'urgent' as CommentSeed['severity'] })));
      const errors = errorsOf(s).join('\n');
      assert.match(errors, /comment\/line must be >= 1/);
      assert.match(errors, /comment\/severity .*allowed values/);
    });

    it('rejects an empty set and non-objects, in repair mode too', () => {
      assert.match(errorsOf(set(), repairOpts).join('\n'), /\/questions must NOT have fewer than 1 items/);
      assert.ok(errorsOf('questions', repairOpts).length > 0);
      assert.ok(errorsOf(null).length > 0);
    });
  });

  describe('QUESTION_SET_SCHEMA', () => {
    type Schema = { properties: Record<string, Schema & { enum?: string[] }>; items: Schema; required?: string[] };
    const root = QUESTION_SET_SCHEMA as Schema;
    const question = root.properties.questions.items;
    const choiceSchema = question.properties.choices.items;
    const seedSchema = choiceSchema.properties.comment;

    it('has exactly the fields of the TypeScript contract', () => {
      // `satisfies` fails to compile if a field is added to or removed from the types without updating these.
      const setKeys = { contractVersion: 1, depth: 1, questions: 1 } satisfies Record<keyof QuestionSet, 1>;
      const questionKeys = { id: 1, nodeId: 1, stage: 1, purpose: 1, depth: 1, prompt: 1, choices: 1, reference: 1, hint: 1 } satisfies Record<keyof Question, 1>;
      const choiceKeys = { id: 1, text: 1, correct: 1, explain: 1, comment: 1 } satisfies Record<keyof Choice, 1>;
      const seedKeys = { file: 1, line: 1, body: 1, severity: 1 } satisfies Record<keyof CommentSeed, 1>;
      const keys = (s: Schema) => Object.keys(s.properties).sort();
      assert.deepEqual(keys(root), Object.keys(setKeys).sort());
      assert.deepEqual(keys(question), Object.keys(questionKeys).sort());
      assert.deepEqual(keys(choiceSchema), Object.keys(choiceKeys).sort());
      assert.deepEqual(keys(seedSchema), Object.keys(seedKeys).sort());
      assert.deepEqual(question.properties.depth.enum, [...DEPTHS]);
      assert.deepEqual(root.properties.depth.properties.proposed.enum, [...DEPTHS]);
    });

    it('needs no rewriting for a CLI: no $ref, no const', () => {
      const text = JSON.stringify(QUESTION_SET_SCHEMA);
      assert.doesNotMatch(text, /"\$ref"|"const"/);
      const cli = toCliSchema(QUESTION_SET_SCHEMA);
      assert.equal(cli.$schema, undefined);
      assert.deepEqual(cli.properties, (QUESTION_SET_SCHEMA as Schema).properties);
    });
  });

  describe('rules', () => {
    it('accepts a minimal valid set and returns a copy', () => {
      const input = set(mc(), judge(), open());
      const r = valid(input);
      assert.deepEqual(r.warnings, []);
      assert.notEqual(r.value, input);
      assert.deepEqual(r.value, input);
    });

    it('duplicate question ids: strict fails, repair keeps the first', () => {
      const s = set(mc(), mc({ prompt: 'Second' }));
      assert.match(errorsOf(s).join('\n'), /question "q1" reuses the id of an earlier question/);
      const r = valid(s, repairOpts);
      assert.deepEqual(r.value.questions.map((q) => q.prompt), ['What happens?']);
      assert.match(r.warnings.join('\n'), /repaired: dropped question "q1", which reuses the id/);
    });

    it('unknown node: strict fails, repair drops the question, and fails if nothing is left', () => {
      const s = set(mc({ id: 'gone', nodeId: 'money/ceilToCents' }), judge());
      assert.match(errorsOf(s).join('\n'), /question "gone" is about unknown node "money\/ceilToCents"/);
      const r = valid(s, repairOpts);
      assert.deepEqual(r.value.questions.map((q) => q.id), ['j1']);
      assert.match(r.warnings.join('\n'), /repaired: dropped question "gone", which is about unknown node/);
      const none = errorsOf(set(mc({ nodeId: 'nope' })), repairOpts);
      assert.match(none.join('\n'), /repair dropped every question/);
    });

    it('duplicate choice ids: strict fails, repair drops the question', () => {
      const q = mc();
      q.choices![1].id = 'a';
      assert.match(errorsOf(set(q, judge())).join('\n'), /question "q1" has duplicate choice id "a"/);
      assert.deepEqual(valid(set(q, judge()), repairOpts).value.questions.map((x) => x.id), ['j1']);
    });

    it('an understand question needs a correct choice', () => {
      const q = mc();
      delete q.choices![0].correct;
      assert.match(errorsOf(set(q, judge())).join('\n'), /question "q1" is an understand question with no correct choice/);
      const r = valid(set(q, judge()), repairOpts);
      assert.deepEqual(r.value.questions.map((x) => x.id), ['j1']);
    });

    it('multiple choice needs at least two choices', () => {
      for (const n of [0, 1]) {
        const q = mc({ choices: mc().choices!.slice(0, n) });
        assert.match(errorsOf(set(q, judge())).join('\n'), new RegExp(`question "q1" has ${n} choices? \\(multiple choice needs at least 2`));
        assert.deepEqual(valid(set(q, judge()), repairOpts).value.questions.map((x) => x.id), ['j1']);
      }
    });

    it("a judge question has no 'correct' fields: strict fails, repair strips them", () => {
      const q = judge();
      q.choices![0].correct = false;
      assert.match(errorsOf(set(q)).join('\n'), /question "j1" choice "fine" has 'correct', but judge questions are never graded/);
      const r = valid(set(q), repairOpts);
      assert.equal('correct' in choice(r.value.questions[0], 'fine'), false);
      assert.match(r.warnings.join('\n'), /repaired: removed 'correct' from question "j1" choice "fine"/);
    });

    it('only judge choices draft comments: strict fails, repair strips the comment', () => {
      const q = mc();
      q.choices![1].comment = seed();
      assert.match(errorsOf(set(q)).join('\n'), /question "q1" choice "b" has a comment, but only judge choices draft comments/);
      const r = valid(set(q), repairOpts);
      assert.equal(choice(r.value.questions[0], 'b').comment, undefined);
      assert.match(r.warnings.join('\n'), /repaired: removed the comment from question "q1" choice "b"/);
    });

    it('warns about an open understand question without a reference, in both modes', () => {
      const s = set(open({ reference: undefined }));
      for (const o of [opts, repairOpts]) {
        const r = valid(s, o);
        assert.match(r.warnings.join('\n'), /question "o1" is an open understand question without a reference/);
      }
      assert.deepEqual(valid(set(open({ purpose: 'judge', reference: undefined }))).warnings, [], 'an open judge question has nothing to grade');
    });

    it('warns when the proposed depth has no questions', () => {
      const s = set(mc({ depth: 'standard' }));
      assert.match(valid(s).warnings.join('\n'), /no question is at the proposed depth "skim"/);
      s.depth.proposed = 'deep';
      assert.deepEqual(valid(s).warnings, []);
    });

    describe('comment anchors', () => {
      it('canonicalises harmless spellings of a path', () => {
        for (const file of ['./src/money/round.ts', 'src\\money\\round.ts', 'src//money/./round.ts']) {
          const r = valid(set(judge({}, seed({ file }))));
          assert.equal(choice(r.value.questions[0], 'change').comment!.file, 'src/money/round.ts', file);
        }
      });

      it('paths outside the repo: strict fails, repair keeps the body without file or line', () => {
        for (const file of ['../ledger/src/money/round.ts', '/etc/passwd', 'C:\\repo\\round.ts']) {
          const s = set(judge({}, seed({ file })));
          assert.match(errorsOf(s).join('\n'), /question "j1" choice "change" comment path ".*" must be repo-relative/, file);
          const r = valid(s, repairOpts);
          assert.deepEqual(choice(r.value.questions[0], 'change').comment, { body: 'Please keep half-up.', severity: 'blocking' }, file);
          assert.match(r.warnings.join('\n'), /repaired: dropped the file and line from the comment of question "j1" choice "change"/);
        }
      });

      it('a file missing from the head revision: strict fails, repair drops file and line', () => {
        const s = set(judge({}, seed({ file: 'src/money/ceil.ts' })));
        assert.match(errorsOf(s).join('\n'), /comment file "src\/money\/ceil.ts" is not in the head revision/);
        const r = valid(s, repairOpts);
        assert.deepEqual(choice(r.value.questions[0], 'change').comment, { body: 'Please keep half-up.', severity: 'blocking' });
      });

      it('a line past the end of the file: strict fails, repair keeps a file-level comment', () => {
        const s = set(judge({}, seed({ line: 31 }))); // round.ts has 30 lines
        assert.match(errorsOf(s).join('\n'), /comment line 31 is past the end of src\/money\/round.ts \(30 lines\)/);
        valid(set(judge({}, seed({ line: 30 }))));
        const r = valid(s, repairOpts);
        assert.deepEqual(choice(r.value.questions[0], 'change').comment, { file: 'src/money/round.ts', body: 'Please keep half-up.', severity: 'blocking' });
        assert.match(r.warnings.join('\n'), /repaired: dropped line 31 from the comment of question "j1" choice "change", past the end/);
      });

      it('a line without a file: strict fails, repair drops the line', () => {
        const s = set(judge({}, { line: 18, body: 'Please keep half-up.', severity: 'blocking' }));
        assert.match(errorsOf(s).join('\n'), /comment has line 18 but no file/);
        const r = valid(s, repairOpts);
        assert.deepEqual(choice(r.value.questions[0], 'change').comment, { body: 'Please keep half-up.', severity: 'blocking' });
      });

      it('accepts a file-level comment and a comment with no anchor', () => {
        valid(set(judge({}, { file: 'src/money/round.ts', body: 'File-level remark.', severity: 'question' })));
        valid(set(judge({}, { body: 'General remark.', severity: 'nit' })));
      });

      it('without readFile, checks the path but not existence or line bounds', () => {
        valid(set(judge({}, seed({ file: 'src/money/ceil.ts', line: 9999 }))), {});
        assert.match(errorsOf(set(judge({}, seed({ file: '../x.ts' }))), {}).join('\n'), /must be repo-relative/);
      });
    });

    it('never mutates its input, in either mode', () => {
      const q = judge({}, seed({ file: './src/money/round.ts', line: 999 }));
      q.choices![0].correct = true;
      const broken = mc({ id: 'gone', nodeId: 'nope' });
      const input = set(q, broken);
      const before = structuredClone(input);
      validateQuestionSet(input, graph, opts);
      validateQuestionSet(input, graph, repairOpts);
      assert.deepEqual(input, before);
    });
  });
});

describe('validateQuestionSet: schema problems confined to questions (repair mode)', () => {
  it('drops just the questions the schema errors point into, with a warning each; strict mode still fails', () => {
    const set = sampleQuestions() as unknown as { questions: Record<string, unknown>[] };
    const n = set.questions.length;
    const withChoices = set.questions.findIndex((q) => Array.isArray(q.choices));
    const long = set.questions[withChoices].id as string;
    (set.questions[withChoices].choices as Record<string, unknown>[])[0].explain = 'x'.repeat(801);
    const last = n - 1;
    set.questions[last].prompt = '';
    const lastId = set.questions[last].id as string;
    assert.equal(validateQuestionSet(set, graph, opts).ok, false);
    const r = validateQuestionSet(set, graph, repairOpts);
    assert.ok(r.ok, r.ok ? '' : r.errors.join('\n'));
    assert.equal(r.value.questions.length, n - 2);
    assert.ok(!r.value.questions.some((q) => q.id === long || q.id === lastId));
    assert.ok(r.warnings.some((w) => w === `repaired: dropped question "${long}", which broke the question-set schema (/choices/0/explain must NOT have more than 800 characters)`), r.warnings.join('\n'));
    assert.ok(r.warnings.some((w) => w.startsWith(`repaired: dropped question "${lastId}"`) && w.includes('/prompt must NOT have fewer than 1 characters')), r.warnings.join('\n'));
    assert.equal((set.questions[withChoices].choices as Record<string, unknown>[])[0].explain, 'x'.repeat(801), 'input untouched');
  });

  it('a problem outside the questions, or in every question, still fails the set', () => {
    const why = sampleQuestions();
    why.depth.why = 'w'.repeat(301);
    assert.equal(validateQuestionSet(why, graph, repairOpts).ok, false);
    const all = sampleQuestions();
    for (const q of all.questions) q.prompt = '';
    assert.equal(validateQuestionSet(all, graph, repairOpts).ok, false);
    assert.equal(validateQuestionSet({ questions: 'none' }, graph, repairOpts).ok, false);
  });
});

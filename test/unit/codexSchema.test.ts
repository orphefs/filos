// toCodexSchema / stripNulls (src/agent/codexSchema.ts): every Filos output schema becomes a valid
// strict-mode schema, and a strict-mode answer (nulls for absent fields) turns back into one the
// Filos validators accept unchanged.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import Ajv from 'ajv';
import { fromCodexAnswer, stripNulls, toCodexSchema } from '../../src/agent/codexSchema';
import { repoReader } from '../../src/agent/repoFiles';
import { toCliSchema } from '../../src/agent/schema';
import { COMMENT_SEED_SCHEMA, DRAFT_COMMENTS_SCHEMA, EVALUATE_SCHEMA, THREAD_REPLY_SCHEMA, validateDraftComments, validateEvaluate, validateThreadReply } from '../../src/agent/taskContracts';
import { validateGraph } from '../../src/contract/validate';
import { QUESTION_SET_SCHEMA, validateQuestionSet } from '../../src/contract/validateQuestions';
import { FAKE_DIR, FAKE_REPO, fixtureGraph } from './helpers';

type Schema = Record<string, unknown>;
const isObj = (v: unknown): v is Schema => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Every Filos output schema, as the providers hand them over (CLI form) or as written. */
const SCHEMAS: Record<string, object> = {
  'review graph (toCliSchema)': toCliSchema(),
  'review graph (raw contract, with $ref and const)': JSON.parse(readFileSync(join(__dirname, '../../schema/review-graph.schema.json'), 'utf8')),
  'question set': toCliSchema(QUESTION_SET_SCHEMA),
  evaluate: EVALUATE_SCHEMA,
  draftComments: DRAFT_COMMENTS_SCHEMA,
  thread: THREAD_REPLY_SCHEMA,
  'comment seed': COMMENT_SEED_SCHEMA,
};

/** Walks every subschema with its path. */
function walk(s: unknown, at: string, visit: (s: Schema, at: string) => void) {
  if (!isObj(s)) return;
  visit(s, at);
  if (isObj(s.properties)) for (const [k, v] of Object.entries(s.properties)) walk(v, `${at}.${k}`, visit);
  if (s.items) walk(s.items, `${at}[]`, visit);
  if (Array.isArray(s.anyOf)) s.anyOf.forEach((b, i) => walk(b, `${at}|${i}`, visit));
}

const acceptsNull = (s: Schema): boolean =>
  (Array.isArray(s.type) && s.type.includes('null')) || (Array.isArray(s.anyOf) && s.anyOf.some((b) => isObj(b) && b.type === 'null'));

/** The original schema's optional properties, as paths (a.b, a[].c), for comparison with the converted nullability. */
function optionalPaths(s: unknown, at: string, out: Set<string>, inline: (n: Schema) => Schema = (n) => n) {
  if (!isObj(s)) return out;
  const node = inline(s);
  if (isObj(node.properties)) {
    const req = new Set(Array.isArray(node.required) ? node.required : []);
    for (const [k, v] of Object.entries(node.properties)) {
      if (!req.has(k)) out.add(`${at}.${k}`);
      optionalPaths(v, `${at}.${k}`, out, inline);
    }
  }
  if (node.items) optionalPaths(node.items, `${at}[]`, out, inline);
  return out;
}

describe('toCodexSchema: strict-mode invariants over every Filos schema', () => {
  for (const [name, source] of Object.entries(SCHEMAS)) {
    it(name, () => {
      const s = toCodexSchema(source);
      assert.equal(s.type, 'object', 'root is an object');
      const original = toCliSchema(source);
      const optional = optionalPaths(original, '$', new Set());
      let objects = 0;
      walk(s, '$', (node, at) => {
        for (const k of ['$ref', 'const', '$schema', '$id', 'definitions', '$defs', 'minLength', 'maxLength', 'oneOf', 'allOf', 'default']) {
          assert.ok(!(k in node), `${at}: "${k}" must not reach Codex`);
        }
        const types = Array.isArray(node.type) ? node.type : [node.type];
        if (types.includes('object')) {
          objects++;
          assert.equal(node.additionalProperties, false, `${at}: additionalProperties false`);
          assert.ok(isObj(node.properties), `${at}: has properties`);
          assert.deepEqual([...(node.required as string[])].sort(), Object.keys(node.properties as Schema).sort(), `${at}: every property is required`);
        }
        if (Array.isArray(node.enum)) assert.ok(node.type !== undefined, `${at}: an enum has a type`);
      });
      assert.ok(objects > 0);
      // Optional properties (and only those) accept null.
      walk(s, '$', (node, at) => {
        if (!isObj(node.properties)) return;
        for (const [k, sub] of Object.entries(node.properties)) {
          const path = `${at.replace(/\|\d+/g, '')}.${k}`;
          assert.equal(acceptsNull(sub as Schema), optional.has(path), `${path}: nullable iff optional`);
        }
      });
    });
  }

  it('compiles with ajv (it is a valid JSON Schema)', () => {
    for (const source of Object.values(SCHEMAS)) new Ajv({ strict: false }).compile(toCodexSchema(source));
  });

  it('keeps enums, numeric bounds, array bounds and descriptions; drops string lengths, saying the maximum in the description', () => {
    const s = toCodexSchema(EVALUATE_SCHEMA) as { properties: Record<string, Schema> };
    assert.deepEqual(s.properties.verdict, { type: 'string', enum: ['correct', 'partly', 'incorrect'] });
    assert.deepEqual(s.properties.reply, { type: 'string', description: 'At most 600 characters.' });
    const body = ((s.properties.comment as { anyOf: Schema[] }).anyOf[0] as { properties: Record<string, Schema> }).properties.body;
    assert.deepEqual(body, { type: 'string', description: 'The comment, addressed to the PR author. At most 2000 characters.' }, 'appended to an existing description');
    const comment = s.properties.comment as { anyOf: Schema[] };
    assert.equal(comment.anyOf.length, 2);
    assert.deepEqual(comment.anyOf[1], { type: 'null' });
    const seed = comment.anyOf[0] as { properties: Record<string, Schema> };
    assert.deepEqual(seed.properties.line, { type: ['integer', 'null'], minimum: 1, description: '1-based head-revision line the comment is about.' });
    assert.deepEqual(seed.properties.severity, { type: 'string', enum: ['blocking', 'suggestion', 'question', 'nit'] });
    const drafts = toCodexSchema(DRAFT_COMMENTS_SCHEMA) as { properties: { comments: Schema } };
    assert.equal(drafts.properties.comments.maxItems, 8);
  });

  it('a const becomes a one-value enum; an optional enum accepts null', () => {
    const g = toCodexSchema(toCliSchema()) as { properties: Record<string, Schema> };
    assert.deepEqual(g.properties.contractVersion, { type: 'string', enum: ['0.1'] });
    const s = toCodexSchema({ type: 'object', properties: { k: { enum: ['a', 'b'] }, n: { const: 3 } }, required: ['n'] }) as { properties: Record<string, Schema> };
    assert.deepEqual(s.properties.k, { type: ['string', 'null'], enum: ['a', 'b', null] });
    assert.deepEqual(s.properties.n, { type: 'integer', enum: [3] });
  });

  it('the review graph leaves generatedBy (the provider fills it) out', () => {
    const g = toCodexSchema(toCliSchema()) as { properties: Schema; required: string[] };
    assert.ok(!('generatedBy' in g.properties));
    assert.ok(!g.required.includes('generatedBy'));
  });

  it('refuses what strict mode cannot express, rather than loosening it', () => {
    assert.throws(() => toCodexSchema({ type: 'object', properties: { a: { allOf: [{ type: 'string' }] } } }), /allOf/);
    assert.throws(() => toCodexSchema({ type: 'object', properties: { a: { not: { type: 'string' } } } }), /"not"/);
    assert.throws(() => toCodexSchema({ type: 'array', items: { type: 'string' } }), /object at the root/);
    assert.throws(() => toCodexSchema({ type: 'object', properties: { a: { $ref: '#/definitions/missing' } } }), /cannot inline/);
  });

  it('does not change its input', () => {
    const before = JSON.stringify(EVALUATE_SCHEMA);
    toCodexSchema(EVALUATE_SCHEMA);
    assert.equal(JSON.stringify(EVALUATE_SCHEMA), before);
  });
});

/** What a strict-mode model writes for `value`: every property of the schema present, null where absent. */
function strictAnswer(value: unknown, s: unknown): unknown {
  if (!isObj(s) || value === null || value === undefined) return value;
  if (Array.isArray(s.anyOf)) {
    const branch = s.anyOf.find((b) => isObj(b) && b.type !== 'null');
    return strictAnswer(value, branch);
  }
  if (Array.isArray(value)) return value.map((v) => strictAnswer(v, s.items));
  if (isObj(value) && isObj(s.properties)) {
    return Object.fromEntries(Object.entries(s.properties).map(([k, sub]) => [k, k in value ? strictAnswer(value[k], sub) : null]));
  }
  return value;
}

describe('stripNulls: a strict-mode answer round-trips into what the validators accept', () => {
  const ajv = new Ajv({ allErrors: true, strict: false });
  const readFile = repoReader(FAKE_REPO);
  const graph = fixtureGraph();
  const questions = JSON.parse(readFileSync(join(FAKE_DIR, 'questions.json'), 'utf8'));

  const cases: { name: string; schema: object; value: unknown; validate: (raw: unknown) => { ok: boolean } }[] = [
    { name: 'review graph', schema: toCliSchema(), value: graph, validate: (raw) => validateGraph(raw, { readFile }) },
    { name: 'question set', schema: toCliSchema(QUESTION_SET_SCHEMA), value: questions, validate: (raw) => validateQuestionSet(raw, graph, { readFile }) },
    {
      name: 'evaluate with a comment',
      schema: EVALUATE_SCHEMA,
      value: { verdict: 'incorrect', reply: 'Look at line 11.', comment: { file: 'money/round.ts', line: 10, body: 'Add a tie test.', severity: 'suggestion' } },
      validate: (raw) => validateEvaluate(raw, { readFile }),
    },
    { name: 'evaluate, no comment', schema: EVALUATE_SCHEMA, value: { verdict: 'correct', reply: 'Yes.' }, validate: (raw) => validateEvaluate(raw) },
    {
      name: 'draft comments',
      schema: DRAFT_COMMENTS_SCHEMA,
      value: { comments: [{ nodeId: 'money', file: 'money/round.ts', line: 3, body: 'b', severity: 'nit' }, { body: 'general', severity: 'question' }] },
      validate: (raw) => validateDraftComments(raw, { readFile, graph, existing: [] }),
    },
    { name: 'thread with a proposal', schema: THREAD_REPLY_SCHEMA, value: { reply: 'r', proposal: 'p' }, validate: (raw) => validateThreadReply(raw) },
    { name: 'thread, no proposal', schema: THREAD_REPLY_SCHEMA, value: { reply: 'r' }, validate: (raw) => validateThreadReply(raw) },
  ];

  for (const c of cases) {
    it(c.name, () => {
      const strictSchema = toCodexSchema(c.schema);
      const answer = strictAnswer(c.value, strictSchema);
      const check = ajv.compile(strictSchema);
      assert.ok(check(answer), `the strict answer fits the converted schema: ${JSON.stringify(check.errors)}`);
      const back = stripNulls(answer);
      assert.deepEqual(back, c.value, 'nulls stripped: the original value again');
      assert.ok(c.validate(back).ok, 'the Filos validator accepts it');
    });
  }

  for (const c of cases) {
    it(`${c.name}: fromCodexAnswer gives the original back too, with nothing to repair`, () => {
      const answer = strictAnswer(c.value, toCodexSchema(c.schema));
      const back = fromCodexAnswer(answer, c.schema);
      assert.deepEqual(back, { value: c.value, repairs: [] });
    });
  }

  it('the graph validator rejects nulls it was not meant to see (why stripping matters)', () => {
    const answer = strictAnswer(graph, toCodexSchema(toCliSchema()));
    assert.equal(validateGraph(answer, { readFile }).ok, false);
    assert.equal(validateGraph(stripNulls(answer), { readFile }).ok, true);
  });

  it('removes null properties at any depth, keeps array elements and other values, and copies', () => {
    const input = { a: null, b: { c: null, d: 0, e: '', f: false }, g: [null, { h: null, i: 1 }], j: [] };
    const out = stripNulls(input);
    assert.deepEqual(out, { b: { d: 0, e: '', f: false }, g: [null, { i: 1 }], j: [] });
    assert.equal(input.a, null, 'input untouched');
    assert.equal(stripNulls(null), null);
    assert.equal(stripNulls('x'), 'x');
  });

  it('no Filos schema accepts null anywhere, so stripping loses nothing a validator could accept', () => {
    for (const [name, s] of Object.entries(SCHEMAS)) {
      walk(toCliSchema(s), '$', (node, at) => {
        const types = Array.isArray(node.type) ? node.type : [node.type];
        assert.ok(!types.includes('null') && !(Array.isArray(node.enum) && node.enum.includes(null)), `${name} ${at} accepts null`);
      });
    }
  });
});

describe('fromCodexAnswer: string lengths strict mode cannot enforce', () => {
  const readFile = repoReader(FAKE_REPO);
  const graph = fixtureGraph();
  const questions = () => JSON.parse(readFileSync(join(FAKE_DIR, 'questions.json'), 'utf8')) as { questions: Record<string, unknown>[] };
  const QS = toCliSchema(QUESTION_SET_SCHEMA);

  it('an optional "" (strict mode\'s filler for a field that does not apply) is dropped, as if null', () => {
    const set = questions();
    const judge = set.questions.findIndex((q) => q.purpose === 'judge');
    set.questions[judge].hint = '';
    set.questions[0].reference = '   ';
    const before = JSON.stringify(set);
    const { value, repairs } = fromCodexAnswer(set, QS);
    assert.equal(JSON.stringify(set), before, 'input untouched');
    const out = value as { questions: Record<string, unknown>[] };
    assert.ok(!('hint' in out.questions[judge]));
    assert.equal(out.questions[0].reference, '   ', 'whitespace meets minLength 1: left for the validators');
    assert.deepEqual(repairs, [`dropped /questions/${judge}/hint (empty): it is optional`]);
    assert.ok(validateQuestionSet(value, graph, { readFile, repair: true }).ok, 'the set is valid again');
    assert.equal(validateQuestionSet(set, graph, { readFile, repair: false }).ok, false, 'it was not before');
  });

  it('an optional string over its maxLength is dropped; a graph node\'s "parent": "" too', () => {
    const set = questions();
    set.questions[1].hint = 'h'.repeat(301);
    const r = fromCodexAnswer(set, QS);
    assert.ok(!('hint' in (r.value as { questions: Record<string, unknown>[] }).questions[1]));
    assert.match(r.repairs[0], /^dropped \/questions\/1\/hint \(301 characters, over the limit of 300\): it is optional$/);

    const g = structuredClone(graph) as unknown as { nodes: Record<string, unknown>[] };
    const mod = g.nodes.findIndex((n) => n.kind === 'module');
    g.nodes[mod].parent = '';
    assert.equal(validateGraph(g, { readFile, repair: true }).ok, false, 'module "parent": "" fails the graph contract');
    const fixed = fromCodexAnswer(g, toCliSchema());
    assert.ok(!('parent' in (fixed.value as typeof g).nodes[mod]));
    assert.ok(validateGraph(fixed.value, { readFile, repair: true }).ok);
  });

  it('a required string broken inside an optional object drops the object (a comment is never cut)', () => {
    const r = fromCodexAnswer({ verdict: 'incorrect', reply: 'Look again.', comment: { body: 'b'.repeat(2001), severity: 'nit', file: null, line: null } }, EVALUATE_SCHEMA);
    assert.deepEqual(r.value, { verdict: 'incorrect', reply: 'Look again.' });
    assert.deepEqual(r.repairs, ['dropped /comment: a field it needs breaks its length limits']);
    const set = questions();
    const judge = set.questions.find((q) => Array.isArray(q.choices) && (q.choices as Record<string, unknown>[]).some((c) => c.comment))!;
    const choice = (judge.choices as Record<string, unknown>[]).find((c) => c.comment)!;
    (choice.comment as Record<string, unknown>).body = '';
    const out = fromCodexAnswer(set, QS);
    const back = (out.value as typeof set).questions.find((q) => q.id === judge.id)!;
    assert.ok(!('comment' in (back.choices as Record<string, unknown>[]).find((c) => c.id === choice.id)!));
  });

  it('a required string broken in an array item or at the root is left for the validators', () => {
    const drafts = { comments: [{ body: 'x'.repeat(2001), severity: 'nit' }, { body: 'ok', severity: 'nit' }] };
    assert.deepEqual(fromCodexAnswer(drafts, DRAFT_COMMENTS_SCHEMA), { value: drafts, repairs: [] }, 'never cut: validateDraftComments drops it');
    assert.equal(validateDraftComments(drafts, { graph, existing: [] }).ok, true);
    assert.deepEqual(fromCodexAnswer({ reply: '' }, THREAD_REPLY_SCHEMA), { value: { reply: '' }, repairs: [] });
  });
});

// Validates untrusted question-set JSON: schema first (ajv), then the rules the schema can't express.
// Agent output is checked in repair mode; the bundled fixture stays strict. See docs/questions-contract.md.

import Ajv, { type ErrorObject } from 'ajv';
import schema from '../../schema/question-set.schema.json';
import type { ReviewGraph } from './graph';
import { DEPTHS, type Choice, type CommentSeed, type Question, type QuestionSet } from './questions';
import { canonicalPath } from './validate';

/** The question-set JSON Schema. Pass it through toCliSchema (src/agent/schema.ts) for --json-schema. */
export const QUESTION_SET_SCHEMA: object = schema;

export type QuestionSetValidation = { ok: true; value: QuestionSet; warnings: string[] } | { ok: false; errors: string[]; warnings: string[] };

export interface ValidateQuestionsOptions {
  /** Returns the head-revision text of a repo-relative file, or undefined if missing. Enables comment line checks. */
  readFile?: (path: string) => string | undefined;
  /**
   * For agent output. A problem confined to one question drops that question; a bad comment anchor
   * loses its file/line but keeps its body; stray 'correct' or 'comment' fields are stripped. Each
   * repair is a warning. Schema failures, and a set with nothing left, are still errors.
   */
  repair?: boolean;
}

const ajv = new Ajv({ allErrors: true, strict: false });
const schemaCheck = ajv.compile(schema);

/** Returns a canonical copy of the set (never the input itself), or the errors. */
export function validateQuestionSet(input: unknown, graph: ReviewGraph, opts: ValidateQuestionsOptions = {}): QuestionSetValidation {
  const warnings: string[] = [];
  if (!schemaCheck(input)) {
    const errors = (schemaCheck.errors ?? []).map(schemaError);
    // Repair: schema problems confined to some questions drop those questions, like any other
    // problem confined to one question; one bad field must not cost the whole set.
    const pruned = opts.repair ? withoutBrokenQuestions(input, schemaCheck.errors ?? []) : undefined;
    if (!pruned || !schemaCheck(pruned.set)) return { ok: false, errors, warnings };
    warnings.push(...pruned.warnings);
    input = pruned.set;
  }
  const set = structuredClone(input) as unknown as QuestionSet;
  const repair = !!opts.repair;
  const errors: string[] = [];
  const nodeIds = new Set(graph.nodes.map((n) => n.id));
  const lineCount = lineCounter(opts.readFile);

  const ids = new Set<string>();
  const kept: Question[] = [];
  for (const q of set.questions) {
    const where = `question "${q.id}"`;
    // Problems that make the question unusable: repair drops it, strict mode fails. Each reads after `where`.
    const fatal: string[] = [];
    if (ids.has(q.id)) fatal.push('reuses the id of an earlier question');
    if (!nodeIds.has(q.nodeId)) fatal.push(`is about unknown node "${q.nodeId}"`);
    if (q.choices) fatal.push(...choiceProblems(q));
    if (fatal.length) {
      if (!repair) errors.push(...fatal.map((p) => `${where} ${p}`));
      else {
        warnings.push(`repaired: dropped ${where}, which ${fatal.join(' and ')}`);
        continue;
      }
    }

    // Fixable problems: repair fixes them, strict mode fails.
    const fix = (problem: string, repaired: string) => (repair ? warnings.push(`repaired: ${repaired}`) : errors.push(problem));
    for (const c of q.choices ?? []) {
      const at = `${where} choice "${c.id}"`;
      if (q.purpose === 'judge' && c.correct !== undefined) {
        fix(`${at} has 'correct', but judge questions are never graded`, `removed 'correct' from ${at} (judge questions are never graded)`);
        delete c.correct;
      }
      if (q.purpose === 'understand' && c.comment) {
        fix(`${at} has a comment, but only judge choices draft comments`, `removed the comment from ${at} (only judge choices draft comments)`);
        delete c.comment;
      }
      if (c.comment) checkSeed(c.comment, at, lineCount, fix);
    }

    if (!q.choices && q.purpose === 'understand' && !q.reference) {
      warnings.push(`${where} is an open understand question without a reference, so self-checks and grading have nothing to compare against`);
    }
    ids.add(q.id);
    kept.push(q);
  }
  set.questions = kept;

  if (repair && kept.length === 0) errors.push('repair dropped every question, so there is nothing to ask');
  const proposed = DEPTHS.indexOf(set.depth.proposed);
  if (kept.length && !kept.some((q) => DEPTHS.indexOf(q.depth) <= proposed)) {
    warnings.push(`no question is at the proposed depth "${set.depth.proposed}", so the review starts empty`);
  }

  return errors.length ? { ok: false, errors, warnings } : { ok: true, value: set, warnings };
}

/** Multiple-choice rules: at least two choices, unique ids, and something right to find in an understand question. */
function choiceProblems(q: Question): string[] {
  const choices = q.choices as Choice[];
  const problems: string[] = [];
  if (choices.length < 2) problems.push(`has ${choices.length} choice${choices.length === 1 ? '' : 's'} (multiple choice needs at least 2; omit choices for an open question)`);
  const seen = new Set<string>();
  for (const c of choices) {
    if (seen.has(c.id)) problems.push(`has duplicate choice id "${c.id}"`);
    seen.add(c.id);
  }
  if (q.purpose === 'understand' && !choices.some((c) => c.correct === true)) problems.push('is an understand question with no correct choice');
  return problems;
}

/**
 * A seed's file must be repo-relative and in the head revision, and its line inside that file.
 * Harmless spellings ('./src/a.ts') are canonicalised. Repair keeps the body and drops what's wrong:
 * a bad file takes its line with it; a bad line alone leaves a file-level comment.
 */
function schemaError(e: ErrorObject): string {
  return `${e.instancePath || '(root)'} ${e.message ?? 'is invalid'}${e.params && 'allowedValues' in e.params ? `: ${(e.params as { allowedValues: unknown[] }).allowedValues.join(', ')}` : ''}`;
}

/**
 * The set without the questions the schema errors point into, or undefined when some error lies
 * outside a question (the set itself is broken) or nothing would be left. Each drop is a warning.
 */
function withoutBrokenQuestions(input: unknown, errors: readonly ErrorObject[]): { set: unknown; warnings: string[] } | undefined {
  const questions = (input as { questions?: unknown } | null)?.questions;
  if (!errors.length || !Array.isArray(questions)) return undefined;
  const bad = new Map<number, string[]>();
  for (const e of errors) {
    const m = /^\/questions\/(\d+)(?:\/|$)/.exec(e.instancePath);
    if (!m) return undefined;
    const i = Number(m[1]);
    bad.set(i, [...(bad.get(i) ?? []), `${e.instancePath.slice(m[0].replace(/\/$/, '').length) || '(the question)'} ${e.message ?? 'is invalid'}`]);
  }
  if (bad.size >= questions.length) return undefined;
  const warnings = [...bad].map(([i, problems]) => {
    const id = (questions[i] as { id?: unknown } | null)?.id;
    const name = typeof id === 'string' && id.trim() ? `question "${id.slice(0, 80)}"` : `question #${i + 1}`;
    return `repaired: dropped ${name}, which broke the question-set schema (${problems.join('; ')})`;
  });
  return { set: { ...(input as object), questions: questions.filter((_, i) => !bad.has(i)) }, warnings };
}

function checkSeed(seed: CommentSeed, at: string, lineCount: (path: string) => number | undefined, fix: (problem: string, repaired: string) => void): void {
  if (seed.file === undefined) {
    if (seed.line !== undefined) {
      fix(`${at} comment has line ${seed.line} but no file`, `dropped line ${seed.line} from the comment of ${at}, which has no file`);
      delete seed.line;
    }
    return;
  }
  const raw = seed.file;
  const file = canonicalPath(raw);
  const lines = file === undefined ? undefined : lineCount(file);
  const fileProblem =
    file === undefined ? `path "${raw}" must be repo-relative, without ".." segments` : lines === undefined ? `file "${file}" is not in the head revision` : undefined;
  if (fileProblem) {
    fix(`${at} comment ${fileProblem}`, `dropped the file and line from the comment of ${at}: ${fileProblem}`);
    delete seed.file;
    delete seed.line;
    return;
  }
  seed.file = file;
  if (seed.line !== undefined && lines !== undefined && seed.line > lines) {
    fix(`${at} comment line ${seed.line} is past the end of ${file} (${lines} lines)`, `dropped line ${seed.line} from the comment of ${at}, past the end of ${file} (${lines} lines)`);
    delete seed.line;
  }
}

/** Line count of a head-revision file, memoised; without readFile every file "exists" with no known end. */
function lineCounter(readFile: ValidateQuestionsOptions['readFile']): (path: string) => number | undefined {
  const counts = new Map<string, number | undefined>();
  return (path) => {
    if (!readFile) return Number.POSITIVE_INFINITY;
    if (!counts.has(path)) {
      const text = readFile(path);
      counts.set(path, text === undefined ? undefined : text.replace(/\n$/, '').split('\n').length);
    }
    return counts.get(path);
  };
}

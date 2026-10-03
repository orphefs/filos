// The four small agent tasks the review uses beside the comprehension pass. Each builds its prompt
// (taskPrompts.ts), hands the provider a CLI-friendly schema and a validator (taskContracts.ts),
// and returns the validated value. Providers are never trusted to honour the schema.

import { realpathSync } from 'node:fs';
import type { ReviewGraph } from '../contract/graph';
import type { CommentSeverity, Question, QuestionSet } from '../contract/questions';
import { canonicalPath } from '../contract/validate';
import { QUESTION_SET_SCHEMA, validateQuestionSet } from '../contract/validateQuestions';
import type { AgentProvider, AskResult } from './provider';
import { repoReader } from './repoFiles';
import { toCliSchema } from './schema';
import {
  cleanText,
  DRAFT_COMMENTS_SCHEMA,
  EVALUATE_SCHEMA,
  THREAD_REPLY_SCHEMA,
  validateDraftComments,
  validateEvaluate,
  validateThreadReply,
  type DraftCommentsResult,
  type EvaluateResult,
  type SeedContext,
  type ThreadReplyResult,
  type Validated,
} from './taskContracts';
import { buildDraftCommentsPrompt, buildEvaluatePrompt, buildQuestionsPrompt, buildThreadPrompt, MAX_QUESTIONS } from './taskPrompts';

export type { DraftCommentsResult, DraftedComment, EvaluateResult, EvaluateVerdict, ThreadReplyResult } from './taskContracts';
export { numberedExcerpt } from './taskPrompts';

export interface GenerateQuestionsInput {
  repoRoot: string;
  graph: ReviewGraph;
  diff: string;
  dependencyIndex?: string;
  signal?: AbortSignal;
  onProgress?: (m: string) => void;
}

/** Questions for an agent-sourced graph. The agent may read the repo (Read/Grep/Glob). */
export async function generateQuestions(p: AgentProvider, a: GenerateQuestionsInput): Promise<AskResult<QuestionSet>> {
  const prompt = buildQuestionsPrompt(a);
  const seeds = seedContext(a.repoRoot);
  const res = await p.ask<QuestionSet>({
    task: 'questions',
    repoRoot: a.repoRoot,
    system: prompt.system,
    prompt: prompt.user,
    schema: toCliSchema(QUESTION_SET_SCHEMA),
    tools: 'read',
    validate: (raw) => checkQuestions(raw, a.graph, seeds),
    signal: a.signal,
    onProgress: a.onProgress,
  });
  return { ...res, warnings: [...prompt.warnings, ...res.warnings] };
}

export interface EvaluateAnswerInput {
  repoRoot: string;
  question: Question;
  nodeSummary: string;
  /** Head-revision code the question is about, ideally from numberedExcerpt so the agent can cite lines. */
  codeExcerpt: string;
  answer: string;
  /** 1 for the first try (the reply hints), 2 or more after that (the reply explains). */
  attempt: number;
  signal?: AbortSignal;
}

/** Grades an open answer, Socratically. No tools: fast and cheap. */
export function evaluateAnswer(p: AgentProvider, a: EvaluateAnswerInput): Promise<AskResult<EvaluateResult>> {
  const prompt = buildEvaluatePrompt(a);
  const seeds = seedContext(a.repoRoot);
  return p.ask<EvaluateResult>({
    task: 'evaluate',
    repoRoot: a.repoRoot,
    system: prompt.system,
    prompt: prompt.user,
    schema: EVALUATE_SCHEMA,
    tools: 'none',
    validate: (raw) => validateEvaluate(raw, seeds),
    signal: a.signal,
  });
}

export interface DraftCommentsInput {
  repoRoot: string;
  graph: ReviewGraph;
  answered: { question: Question; answer: string; verdict: string }[];
  /** The reviewer's free-text notes. */
  notes: string[];
  /** Drafts the review already has, so the agent adds only new ones. */
  existing: { file?: string; line?: number; body: string }[];
  signal?: AbortSignal;
}

/** New review comments from the answers and notes so far. No tools. */
export async function draftComments(p: AgentProvider, a: DraftCommentsInput): Promise<AskResult<DraftCommentsResult>> {
  const prompt = buildDraftCommentsPrompt(a);
  const seeds = seedContext(a.repoRoot);
  const res = await p.ask<DraftCommentsResult>({
    task: 'draftComments',
    repoRoot: a.repoRoot,
    system: prompt.system,
    prompt: prompt.user,
    schema: DRAFT_COMMENTS_SCHEMA,
    tools: 'none',
    validate: (raw) => validateDraftComments(raw, { ...seeds, graph: a.graph, existing: a.existing }),
    signal: a.signal,
  });
  return { ...res, warnings: [...prompt.warnings, ...res.warnings] };
}

export interface ThreadReplyInput {
  repoRoot: string;
  comment: { file?: string; line?: number; body: string; severity: CommentSeverity };
  nodeSummary: string;
  codeExcerpt: string;
  /** Earlier messages, oldest first, without the new one. */
  thread: { role: 'user' | 'agent'; text: string }[];
  message: string;
  signal?: AbortSignal;
}

/** The agent's reply in a comment thread, optionally with a complete rewritten body. No tools. */
export async function threadReply(p: AgentProvider, a: ThreadReplyInput): Promise<AskResult<ThreadReplyResult>> {
  const prompt = buildThreadPrompt(a);
  const res = await p.ask<ThreadReplyResult>({
    task: 'thread',
    repoRoot: a.repoRoot,
    system: prompt.system,
    prompt: prompt.user,
    schema: THREAD_REPLY_SCHEMA,
    tools: 'none',
    validate: (raw) => validateThreadReply(raw, { currentBody: a.comment.body }),
    signal: a.signal,
  });
  return { ...res, warnings: [...prompt.warnings, ...res.warnings] };
}

// --- questions: repairs around the shared validator --------------------------------------------

/**
 * validateQuestionSet in repair mode, plus what only the agent path needs: absolute comment paths
 * (the Read tool works with them) made repo-relative first, display text cleaned like every other
 * task's (it is shown to the reviewer, and a judge choice's comment may be posted), the question
 * cap, and a warning for a changed module without a gate question (the host then asks its generic one).
 */
export function checkQuestions(raw: unknown, graph: ReviewGraph, seeds: SeedContext): Validated<QuestionSet> {
  const warnings: string[] = [];
  const input = rebaseCommentPaths(raw, seeds.repoRoot, warnings);
  const v = validateQuestionSet(input, graph, { readFile: seeds.readFile, repair: true });
  if (!v.ok) return { ok: false, errors: v.errors };
  const set = cleanQuestionText(v.value, warnings);
  warnings.push(...v.warnings);
  if (!set.questions.length) return { ok: false, errors: ['cleaning the text left no question to ask'] };

  if (set.questions.length > MAX_QUESTIONS) {
    // Keep every gate (predict) question, then the rest in the agent's order.
    const keep = new Set(set.questions.filter((q) => q.stage === 'predict').slice(0, MAX_QUESTIONS).map((q) => q.id));
    for (const q of set.questions) if (keep.size < MAX_QUESTIONS) keep.add(q.id);
    warnings.push(`repaired: kept ${MAX_QUESTIONS} of ${set.questions.length} questions`);
    set.questions = set.questions.filter((q) => keep.has(q.id));
  }
  for (const m of graph.nodes) {
    if (m.kind !== 'module' || m.change === 'context') continue;
    if (!set.questions.some((q) => q.nodeId === m.id && q.stage === 'predict')) warnings.push(`changed module "${m.id}" has no predict question`);
  }
  return { ok: true, value: set, warnings };
}

/**
 * cleanText over every string the reviewer reads or GitHub may receive: control characters and
 * bidirectional overrides make text read differently from what it is. A question left without a
 * prompt or a choice's text is dropped; an optional field left empty goes, and so does a comment
 * seed left without a body.
 */
function cleanQuestionText(set: QuestionSet, warnings: string[]): QuestionSet {
  set.depth.why = cleanText(set.depth.why);
  set.questions = set.questions.filter((q) => {
    q.prompt = cleanText(q.prompt);
    for (const field of ['reference', 'hint'] as const) {
      if (q[field] === undefined) continue;
      const text = cleanText(q[field]);
      if (text) q[field] = text;
      else delete q[field];
    }
    for (const c of q.choices ?? []) {
      c.text = cleanText(c.text);
      c.explain = cleanText(c.explain);
      if (!c.comment) continue;
      c.comment.body = cleanText(c.comment.body);
      if (!c.comment.body) {
        warnings.push(`repaired: dropped the comment of question "${q.id}" choice "${c.id}", which has no text once cleaned`);
        delete c.comment;
      }
    }
    if (q.prompt && (q.choices ?? []).every((c) => c.text)) return true;
    warnings.push(`repaired: dropped question "${q.id}", which has an empty prompt or choice once cleaned`);
    return false;
  });
  return set;
}

/** Copies the raw set with absolute comment paths under the repo made repo-relative. */
function rebaseCommentPaths(raw: unknown, repoRoot: string | undefined, warnings: string[]): unknown {
  if (!repoRoot || !isRecord(raw) || !Array.isArray(raw.questions)) return raw;
  const copy = structuredClone(raw) as { questions: unknown[] };
  for (const q of copy.questions) {
    if (!isRecord(q) || !Array.isArray(q.choices)) continue;
    for (const c of q.choices) {
      if (!isRecord(c) || !isRecord(c.comment) || typeof c.comment.file !== 'string') continue;
      const file = c.comment.file;
      if (!/^([\\/]|[A-Za-z]:)/.test(file)) continue;
      const rel = canonicalPath(file, repoRoot);
      if (rel !== undefined) {
        c.comment.file = rel;
        warnings.push(`repaired: made absolute path "${file}" repo-relative ("${rel}")`);
      }
    }
  }
  return copy;
}

/** Reader and real root for checking comment anchors; the CLI reports symlink-resolved absolute paths. */
function seedContext(repoRoot: string): SeedContext {
  try {
    return { readFile: repoReader(repoRoot), repoRoot: realpathSync(repoRoot) };
  } catch {
    // A missing repo fails in the provider with a clear message; validation never runs.
    return {};
  }
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

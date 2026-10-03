// Output contracts of the small agent tasks (evaluate, draftComments, thread): a CLI-friendly JSON
// schema for --json-schema (no $ref, no const) and a validator for each. The schema only steers the
// model; the validator is what we trust, and it repairs what it safely can, with a warning each time.

import type { ReviewGraph } from '../contract/graph';
import type { CommentSeed, CommentSeverity } from '../contract/questions';
import { canonicalPath } from '../contract/validate';
import { lineCount } from './repoFiles';

export const MAX_REPLY_CHARS = 600;
export const MAX_PROPOSAL_CHARS = 2000;
export const MAX_COMMENT_CHARS = 2000;
export const MAX_DRAFTED_COMMENTS = 8;

export const SEVERITIES: readonly CommentSeverity[] = ['blocking', 'suggestion', 'question', 'nit'];
export type EvaluateVerdict = 'correct' | 'partly' | 'incorrect';
export const EVALUATE_VERDICTS: readonly EvaluateVerdict[] = ['correct', 'partly', 'incorrect'];

export interface EvaluateResult {
  verdict: EvaluateVerdict;
  /** To the reviewer: a Socratic hint on a first wrong attempt, an explanation after that. */
  reply: string;
  /** Only when the answer exposed a real problem in the PR. */
  comment?: CommentSeed;
}

export type DraftedComment = CommentSeed & { nodeId?: string };

export interface DraftCommentsResult {
  /** New comments only; duplicates of existing drafts are dropped. May be empty. */
  comments: DraftedComment[];
}

export interface ThreadReplyResult {
  reply: string;
  /** A complete rewritten comment body the reviewer can adopt. */
  proposal?: string;
}

export type Validated<T> = { ok: true; value: T; warnings: string[] } | { ok: false; errors: string[] };

/** What seed validation needs to check file/line against the head revision. */
export interface SeedContext {
  /** Reads a repo-relative head-revision file (confined to the repo), or undefined if missing. */
  readFile?: (path: string) => string | undefined;
  /** Real (symlink-resolved) repo root, so absolute paths under it can be made repo-relative. */
  repoRoot?: string;
}

// --- schemas -----------------------------------------------------------------------------------

export const COMMENT_SEED_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['body', 'severity'],
  properties: {
    file: { type: 'string', minLength: 1, maxLength: 500, description: 'Repo-relative path in the head revision, forward slashes.' },
    line: { type: 'integer', minimum: 1, description: '1-based head-revision line the comment is about.' },
    body: { type: 'string', minLength: 1, maxLength: MAX_COMMENT_CHARS, description: 'The comment, addressed to the PR author.' },
    severity: { type: 'string', enum: [...SEVERITIES] },
  },
} as const;

export const EVALUATE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['verdict', 'reply'],
  properties: {
    verdict: { type: 'string', enum: [...EVALUATE_VERDICTS] },
    reply: { type: 'string', minLength: 1, maxLength: MAX_REPLY_CHARS },
    comment: COMMENT_SEED_SCHEMA,
  },
} as const;

export const DRAFT_COMMENTS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['comments'],
  properties: {
    comments: {
      type: 'array',
      maxItems: MAX_DRAFTED_COMMENTS,
      items: {
        ...COMMENT_SEED_SCHEMA,
        properties: { nodeId: { type: 'string', minLength: 1, description: 'Id of the graph node the comment is about.' }, ...COMMENT_SEED_SCHEMA.properties },
      },
    },
  },
} as const;

export const THREAD_REPLY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['reply'],
  properties: {
    reply: { type: 'string', minLength: 1, maxLength: MAX_REPLY_CHARS },
    proposal: { type: 'string', minLength: 1, maxLength: MAX_PROPOSAL_CHARS, description: 'The complete rewritten comment body.' },
  },
} as const;

// --- text hygiene ------------------------------------------------------------------------------

/**
 * Agent text shown to the reviewer and possibly posted to GitHub: drops control characters (except
 * newline and tab) and bidirectional overrides, which can make text read differently from what it is.
 */
export function cleanText(s: string): string {
  return s
    .replace(/\r\n?/g, '\n')
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '')
    .replace(/[‪-‮⁦-⁩]/g, '')
    .trim();
}

/** Cuts at a word boundary and marks the cut, so the text stays readable. */
export function capText(s: string, max: number): string {
  if (s.length <= max) return s;
  const cut = s.slice(0, max - 1);
  const space = cut.lastIndexOf(' ');
  return (space > max * 0.6 ? cut.slice(0, space) : cut).trimEnd() + '…';
}

const normalised = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim();
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** A required display string: cleaned, non-empty, capped (with a warning) rather than rejected. */
function displayText(v: unknown, field: string, max: number, errors: string[], warnings: string[]): string {
  if (typeof v !== 'string') {
    errors.push(`${field} must be a string`);
    return '';
  }
  const text = cleanText(v);
  if (!text) {
    errors.push(`${field} is empty`);
    return '';
  }
  if (text.length > max) {
    warnings.push(`repaired: cut ${field} from ${text.length} to ${max} characters`);
    return capText(text, max);
  }
  return text;
}

// --- comment seeds -----------------------------------------------------------------------------

/**
 * A comment seed from the agent, or undefined (with a warning) when it can't be used. A bad
 * file or line only loses the anchor: the comment survives as a general one.
 */
export function checkSeed(raw: unknown, where: string, ctx: SeedContext, warnings: string[]): CommentSeed | undefined {
  if (!isRecord(raw)) {
    warnings.push(`dropped ${where}: not an object`);
    return undefined;
  }
  if (typeof raw.severity !== 'string' || !SEVERITIES.includes(raw.severity as CommentSeverity)) {
    warnings.push(`dropped ${where}: severity must be one of ${SEVERITIES.join(', ')}`);
    return undefined;
  }
  const body = typeof raw.body === 'string' ? cleanText(raw.body) : '';
  if (!body) {
    warnings.push(`dropped ${where}: empty body`);
    return undefined;
  }
  if (body.length > MAX_COMMENT_CHARS) {
    // A cut comment could be posted half-finished; better to lose it.
    warnings.push(`dropped ${where}: body is ${body.length} characters (at most ${MAX_COMMENT_CHARS})`);
    return undefined;
  }
  const seed: CommentSeed = { body, severity: raw.severity as CommentSeverity };

  let fileText: string | undefined;
  if (raw.file !== undefined && raw.file !== null) {
    const file = typeof raw.file === 'string' ? canonicalPath(raw.file, ctx.repoRoot) : undefined;
    fileText = file !== undefined ? (ctx.readFile ? ctx.readFile(file) : '') : undefined;
    if (file === undefined || fileText === undefined) {
      const why = file === undefined ? 'is not a path inside the repo' : 'is not in the head revision';
      warnings.push(`repaired: ${where} file "${String(raw.file).slice(0, 200)}" ${why}; kept it as a general comment`);
    } else {
      seed.file = file;
    }
  }
  if (raw.line !== undefined && raw.line !== null) {
    const line = raw.line;
    if (seed.file === undefined) {
      if (raw.file === undefined || raw.file === null) warnings.push(`repaired: ${where} has a line but no file; dropped the line`);
    } else if (typeof line !== 'number' || !Number.isInteger(line) || line < 1) {
      warnings.push(`repaired: ${where} line ${JSON.stringify(line)} is not a 1-based line number; dropped it`);
    } else if (ctx.readFile && fileText !== undefined && line > lineCount(fileText)) {
      warnings.push(`repaired: ${where} line ${line} is past the end of ${seed.file} (${lineCount(fileText)} lines); dropped it`);
    } else {
      seed.line = line;
    }
  }
  return seed;
}

// --- validators --------------------------------------------------------------------------------

export function validateEvaluate(raw: unknown, ctx: SeedContext = {}): Validated<EvaluateResult> {
  if (!isRecord(raw)) return { ok: false, errors: ['the answer must be an object'] };
  const errors: string[] = [];
  const warnings: string[] = [];
  const verdict = raw.verdict as EvaluateVerdict;
  if (!EVALUATE_VERDICTS.includes(verdict)) errors.push(`verdict must be one of ${EVALUATE_VERDICTS.join(', ')}, got ${JSON.stringify(raw.verdict)?.slice(0, 40)}`);
  const reply = displayText(raw.reply, 'reply', MAX_REPLY_CHARS, errors, warnings);
  if (errors.length) return { ok: false, errors };
  const value: EvaluateResult = { verdict, reply };
  if (raw.comment !== undefined && raw.comment !== null) {
    const seed = checkSeed(raw.comment, 'the proposed comment', ctx, warnings);
    if (seed) value.comment = seed;
  }
  return { ok: true, value, warnings };
}

export interface DraftCommentsContext extends SeedContext {
  graph: ReviewGraph;
  /** Bodies of the drafts the review already has; the agent's answer must not repeat them. */
  existing: { body: string }[];
}

export function validateDraftComments(raw: unknown, ctx: DraftCommentsContext): Validated<DraftCommentsResult> {
  if (!isRecord(raw)) return { ok: false, errors: ['the answer must be an object'] };
  if (!Array.isArray(raw.comments)) return { ok: false, errors: ['comments must be an array'] };
  const warnings: string[] = [];
  const nodeIds = new Set(ctx.graph.nodes.map((n) => n.id));
  const seen = new Set(ctx.existing.map((c) => normalised(c.body)));
  const comments: DraftedComment[] = [];
  raw.comments.forEach((item, i) => {
    const where = `comment ${i + 1}`;
    if (comments.length >= MAX_DRAFTED_COMMENTS) {
      warnings.push(`dropped ${where}: at most ${MAX_DRAFTED_COMMENTS} comments per draft`);
      return;
    }
    const seed = checkSeed(item, where, ctx, warnings);
    if (!seed) return;
    const key = normalised(seed.body);
    if (seen.has(key)) {
      warnings.push(`dropped ${where}: it repeats an existing comment`);
      return;
    }
    seen.add(key);
    const c: DraftedComment = { ...seed };
    const nodeId = (item as Record<string, unknown>).nodeId;
    if (nodeId !== undefined && nodeId !== null) {
      if (typeof nodeId === 'string' && nodeIds.has(nodeId)) c.nodeId = nodeId;
      else warnings.push(`repaired: ${where} names node ${JSON.stringify(nodeId)?.slice(0, 80)}, which is not in the graph; dropped the node`);
    }
    comments.push(c);
  });
  return { ok: true, value: { comments }, warnings };
}

export function validateThreadReply(raw: unknown, ctx: { currentBody?: string } = {}): Validated<ThreadReplyResult> {
  if (!isRecord(raw)) return { ok: false, errors: ['the answer must be an object'] };
  const errors: string[] = [];
  const warnings: string[] = [];
  const reply = displayText(raw.reply, 'reply', MAX_REPLY_CHARS, errors, warnings);
  if (errors.length) return { ok: false, errors };
  const value: ThreadReplyResult = { reply };
  if (raw.proposal !== undefined && raw.proposal !== null) {
    const proposal = typeof raw.proposal === 'string' ? cleanText(raw.proposal) : '';
    if (typeof raw.proposal !== 'string') warnings.push('dropped the proposal: not a string');
    else if (!proposal) {
      // An empty proposal just means "no rewrite".
    } else if (proposal.length > MAX_PROPOSAL_CHARS) {
      // Adopting a cut-off rewrite would replace a whole comment with half of one.
      warnings.push(`dropped the proposal: ${proposal.length} characters (at most ${MAX_PROPOSAL_CHARS})`);
    } else if (ctx.currentBody !== undefined && normalised(proposal) === normalised(ctx.currentBody)) {
      warnings.push('dropped the proposal: it is the current comment unchanged');
    } else {
      value.proposal = proposal;
    }
  }
  return { ok: true, value, warnings };
}

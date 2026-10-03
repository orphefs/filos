// Review state: questionnaire answers, draft comments, didactic progress. The host owns it
// (src/review/model.ts) and sends the webview a full snapshot after every change.

import type { CommentSeverity, Depth, Question } from '../contract/questions';

export type Mode = 'fast' | 'didactic';

/** Asked, never assumed: commit history is no proxy, since an agent may have written that commit. */
export type Familiarity = 'new' | 'some' | 'known';

export type Verdict = 'correct' | 'partly' | 'incorrect' | 'noted';

export interface Attempt {
  at: string; // ISO
  choiceId?: string;
  text?: string;
  /** noted = a judge answer or a prediction; never graded. */
  verdict: Verdict;
  /** Feedback shown under the answer: an explanation, a Socratic hint, or the agent's reply. */
  reply: string;
  /** Who produced the verdict. */
  by: 'choice' | 'agent' | 'self';
}

export interface AnswerState {
  questionId: string;
  attempts: Attempt[];
  /** Finished: answered correctly, answered twice, noted, or self-checked. */
  done: boolean;
  /** An agent is grading the latest open answer. */
  pending?: boolean;
  /** Open answer waiting for the reviewer's self-check against the reference (no agent). */
  awaitingSelfCheck?: boolean;
  /**
   * Fingerprint of the question as it was answered (questionKey in model.ts). A re-run may reuse
   * the id for a different question; the answer doesn't carry over to it.
   */
  questionKey?: string;
}

/**
 * The answer to a question in a snapshot, or undefined. Question ids come from agent output, so only
 * own keys count: "constructor" or "toString" must not find Object.prototype's members.
 */
export function answerFor(answers: Readonly<Record<string, AnswerState>>, questionId: string): AnswerState | undefined {
  return Object.prototype.hasOwnProperty.call(answers, questionId) ? answers[questionId] : undefined;
}

export interface ThreadMessage {
  role: 'user' | 'agent';
  text: string;
  /** Agent messages may propose a rewritten comment the reviewer can adopt. */
  proposal?: string;
}

export type CommentStatus = 'draft' | 'accepted' | 'rejected';

export type CommentOrigin = { kind: 'question'; questionId: string; choiceId?: string } | { kind: 'agent' } | { kind: 'note' };

export interface DraftComment {
  id: string;
  nodeId?: string;
  file?: string;
  line?: number;
  body: string;
  severity: CommentSeverity;
  origin: CommentOrigin;
  status: CommentStatus;
  /** True once the reviewer edited the body (amend or adopted proposal). */
  amended: boolean;
  thread: ThreadMessage[];
  /** The agent is replying in the thread. */
  threadPending?: boolean;
  /**
   * The commit (full id) whose head revision `file` and `line` refer to: the one under review when
   * the comment was drafted. Only a comment on the commit GitHub has as the PR's head goes inline.
   */
  commit?: string;
  /** Already posted to the PR: a later post leaves it out. Set in snapshots only. */
  posted?: boolean;
  /** Its line refers to an earlier commit than the one under review, so it can't sit inline. Set in snapshots only. */
  outdated?: boolean;
}

/** A top-level module of the graph: a territory on the didactic map. */
export interface Territory {
  nodeId: string;
  explored: boolean;
  familiarity?: Familiarity;
  /** Private, local, 0..1. */
  confidence: number;
  questionsDone: number;
  questionsTotal: number;
}

export interface Gate {
  nodeId: string;
  step: 'familiarity' | 'predict';
  /** The predict question being asked (step 'predict'). */
  questionId?: string;
}

export type PostTarget = { kind: 'github'; repo: string; number: number; url: string } | { kind: 'none'; reason: string };

export interface PostState {
  target: PostTarget;
  status: 'idle' | 'posting' | 'posted' | 'error';
  url?: string;
  error?: string;
}

export interface ReviewSnapshot {
  mode: Mode;
  depth: {
    proposed: Depth;
    why: string;
    chosen: Depth;
    /** Questions each depth would ask (the question set's own), for the depth menu. Absent while there is no set. */
    counts?: Partial<Record<Depth, number>>;
  };
  /** Questions at the chosen depth, ordered for asking (riskiest node first, predict before check). */
  questions: Question[];
  answers: Record<string, AnswerState>;
  comments: DraftComment[];
  territories: Territory[];
  coverage: { explored: number; total: number };
  /** Didactic: the territory being entered, if any. */
  gate?: Gate;
  questionsStatus: { state: 'ready' | 'loading' | 'error' | 'none'; message?: string };
  /** Whether open answers are graded and threads answered by the agent (else self-checks). */
  agentAvailable: boolean;
  /** Agent is drafting comments from the answers. */
  draftingPending?: boolean;
  post: PostState;
}

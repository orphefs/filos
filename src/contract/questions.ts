// The question-set contract (v0.1): what the reviewer is asked about a PR.
// Fixtures hand-write it; the agent's questions pass produces it. Shared by host and webview.

export const QUESTIONS_CONTRACT_VERSION = '0.1';

/** How much of the PR the review covers. Questions carry the smallest depth that includes them. */
export type Depth = 'skim' | 'standard' | 'deep';
export const DEPTHS: readonly Depth[] = ['skim', 'standard', 'deep'];

export interface QuestionSet {
  contractVersion: typeof QUESTIONS_CONTRACT_VERSION;
  /** The agent's proposed depth, from how important/risky the PR is. The user can override it. */
  depth: { proposed: Depth; why: string };
  questions: Question[];
}

/**
 * predict — asked before the code is shown ("asks before telling"): the didactic gate into a territory.
 * check   — asked after the reviewer has read the code.
 */
export type QuestionStage = 'predict' | 'check';

/**
 * understand — has a right answer; feeds the private confidence score.
 * judge      — the reviewer's call; choices may draft a review comment. Never graded.
 */
export type QuestionPurpose = 'understand' | 'judge';

export interface Question {
  /** Unique, stable, e.g. "q-money-predict". */
  id: string;
  /** The graph node it is about (a module, symbol, or external). */
  nodeId: string;
  stage: QuestionStage;
  purpose: QuestionPurpose;
  depth: Depth;
  prompt: string;
  /** Present: multiple choice, graded locally. Absent: open question, free text. */
  choices?: Choice[];
  /** Open questions: what a good answer covers. Used for self-checks and agent grading. */
  reference?: string;
  /** A Socratic nudge shown after a wrong first attempt, instead of the answer. */
  hint?: string;
}

export interface Choice {
  id: string;
  text: string;
  /** understand questions only: at least one choice is correct. */
  correct?: boolean;
  /** Shown once chosen: why this is right or wrong, or what follows from the judgement. */
  explain: string;
  /** judge questions only: choosing this drafts a review comment. */
  comment?: CommentSeed;
}

export type CommentSeverity = 'blocking' | 'suggestion' | 'question' | 'nit';

export interface CommentSeed {
  /** Repo-relative path in the head revision, and a 1-based line, for an inline comment. */
  file?: string;
  line?: number;
  body: string;
  severity: CommentSeverity;
}

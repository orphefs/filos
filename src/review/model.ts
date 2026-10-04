// The review state machine: questionnaire answers, draft comments, didactic territories and the
// gate into them. Pure TypeScript with no vscode import, so unit tests and the browser harness run
// it as is. The host owns one per review, applies webview actions to it, does whatever effect a
// method returns (agent calls, posting), and sends snapshot() to the webview after every change.
// docs/review-and-didactic.md is the spec; everything here is provisional with it.

import type { ReviewGraph } from '../contract/graph';
import { DEPTHS, type Choice, type CommentSeed, type CommentSeverity, type Depth, type Question, type QuestionSet } from '../contract/questions';
import type { ReviewAction } from '../protocol';
import { adjustConfidence, FAMILIARITY_START, modulePath, type ConfidenceStore, type UnderstandOutcome } from './confidence';
import { GraphIndex, includesDepth, isDepth, isRevealed, orderQuestions } from './order';
import type { AnswerState, Attempt, CommentStatus, DraftComment, Familiarity, Gate, Mode, PostState, PostTarget, ReviewSnapshot, ThreadMessage, Verdict } from './types';

export type QuestionsStatus = ReviewSnapshot['questionsStatus'];

/** Per-PR state the host keeps in workspaceState. Small: no event log, no confidence (that's global). */
export interface PersistedReview {
  version: 1;
  /** Only when the reviewer overrode the proposal; otherwise the proposal (which may change) applies. */
  chosenDepth?: Depth;
  answers: Record<string, AnswerState>;
  comments: DraftComment[];
  /** Territory node ids. */
  explored: string[];
  /** Familiarity answers per territory node id. */
  familiarity: Record<string, Familiarity>;
  /** Ids of comments already posted to the PR, so a later post doesn't repeat them. */
  posted?: string[];
  /** Ids of comments whose post ended without a clear answer (a timeout, a 5xx): GitHub may have them. */
  maybePosted?: string[];
}

export interface ReviewModelOptions {
  graph: ReviewGraph;
  questions: QuestionSet | undefined;
  questionsStatus: QuestionsStatus;
  mode: Mode;
  /** A PersistedReview read back from workspaceState. Validated here, so a stale or hand-edited value can't break the model. */
  persisted?: unknown;
  confidence: ConfidenceStore;
  /** Open answers are graded and threads answered by the agent; otherwise self-checks. */
  agentAvailable: boolean;
  /** Display name of the configured agent CLI (snapshot.agentName); it can change while the review is open. */
  agentName?: string;
  post: PostTarget;
  /** The commit under review (full id), when known: new comments' lines refer to it. */
  headOid?: string;
  /** ISO timestamp; injected so tests are deterministic. */
  now: () => string;
}

/** What the host must do after a method returns. */
export type ReviewEffect =
  | { kind: 'none' }
  /** Grade an open answer with the agent's `evaluate` task (attempt is 1-based), then call applyEvaluation or failEvaluation. */
  | { kind: 'evaluate'; questionId: string; attempt: number; text: string }
  /** Ask the agent's `thread` task for a reply, then call applyThreadReply or failThread. */
  | { kind: 'thread'; commentId: string }
  /** Run the agent's `draftComments` task, then call applyAgentDrafts or failDrafting. */
  | { kind: 'draft' }
  /**
   * Confirm with the reviewer, post buildGithubReview(postingComments(), …), and report via
   * setPostState with the ids sent ('posted' marks exactly those). While it runs, those comments
   * can't change. `comments` (as they were when Post was clicked) may be empty: say there's nothing to post.
   */
  | { kind: 'post'; comments: DraftComment[] }
  /** Export reviewToMarkdown(...) to the clipboard and an untitled document. */
  | { kind: 'export' };

export const NO_EFFECT: ReviewEffect = Object.freeze({ kind: 'none' });

/** The agent `evaluate` task's output (src/agent/taskContracts.ts EvaluateResult). */
export interface EvaluationResult {
  verdict: 'correct' | 'partly' | 'incorrect';
  reply: string;
  /** A comment the answer suggests, e.g. the reviewer spotted a real problem. */
  comment?: CommentSeed;
}

/** The agent `thread` task's output (ThreadReplyResult). */
export interface ThreadReply {
  reply: string;
  /** A full rewritten comment the reviewer can adopt. */
  proposal?: string;
}

/** One comment from the agent `draftComments` task (DraftedComment). */
export interface AgentDraftSeed extends CommentSeed {
  nodeId?: string;
}

export const GATE_QUESTION_PREFIX = 'gate:';

/** Id of the synthetic "what do you expect…" question for a territory with no predict question. */
export function gateQuestionId(nodeId: string): string {
  return GATE_QUESTION_PREFIX + nodeId;
}

export function isGateQuestionId(id: string): boolean {
  return id.startsWith(GATE_QUESTION_PREFIX);
}

/** Reply shown under a noted prediction (the synthetic gate question). */
export const NOTED_PREDICTION_REPLY = 'Noted. Keep it in mind and see whether the code agrees.';

const FAMILIARITIES: readonly Familiarity[] = ['new', 'some', 'known'];
const SEVERITIES: readonly CommentSeverity[] = ['blocking', 'suggestion', 'question', 'nit'];
const VERDICTS: readonly Verdict[] = ['correct', 'partly', 'incorrect', 'noted'];
const STATUSES: readonly CommentStatus[] = ['draft', 'accepted', 'rejected'];
const DEFAULT_DEPTH: Depth = 'standard';
/** No question takes more than two tries (a hint, then the answer); judgements keep only the latest. */
const MAX_ATTEMPTS = 2;
const OID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

/** Sets an own property, so ids from agent output like "__proto__" stay ordinary keys. */
function put<T>(obj: Record<string, T>, key: string, value: T): void {
  Object.defineProperty(obj, key, { value, enumerable: true, writable: true, configurable: true });
}

/** A short, stable hash of a string (cyrb53): enough to tell two versions of a question apart. */
function hash(text: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

/**
 * What an answer was an answer to: the question's node, kind, prompt, reference and choices. A
 * re-run's question set may reuse an id ("q-money-predict") for a different question; an answer
 * stored under that id is dropped rather than shown as the answer to the new one.
 */
export function questionKey(q: Question): string {
  const choices = (q.choices ?? []).map((c) => [c.id, c.text, c.correct === true]);
  return hash(JSON.stringify([q.nodeId, q.stage, q.purpose, q.prompt, q.reference ?? '', choices]));
}

/** Same text at the same place: a posted mark stored by another review of the PR applies to it. */
function sameComment(a: Pick<DraftComment, 'body' | 'file' | 'line'>, b: Pick<DraftComment, 'body' | 'file' | 'line'>): boolean {
  return a.body === b.body && a.file === b.file && a.line === b.line;
}

/**
 * `next` with the posted and maybe-posted marks of `stored` (another PersistedReview, or anything)
 * added, for comments that are the same comment in both. Marks only ever grow, so a review writing
 * from a stale copy can't make a posted comment postable again.
 */
export function mergePostedMarks(next: PersistedReview, stored: unknown): PersistedReview {
  const old = parsePersistedReview(stored);
  if (!old) return next;
  const mine = new Map(next.comments.map((c) => [c.id, c]));
  const theirs = new Map(old.comments.map((c) => [c.id, c]));
  const same = (id: string) => {
    const a = mine.get(id);
    const b = theirs.get(id);
    return !!a && !!b && sameComment(a, b);
  };
  const posted = new Set([...(next.posted ?? []), ...(old.posted ?? []).filter(same)]);
  const maybe = new Set([...(next.maybePosted ?? []), ...(old.maybePosted ?? []).filter(same)].filter((id) => !posted.has(id)));
  const out: PersistedReview = { ...next };
  delete out.posted;
  delete out.maybePosted;
  if (posted.size) out.posted = next.comments.filter((c) => posted.has(c.id)).map((c) => c.id);
  if (maybe.size) out.maybePosted = next.comments.filter((c) => maybe.has(c.id)).map((c) => c.id);
  return out;
}

export class ReviewModel {
  private readonly index: GraphIndex;
  private readonly confidence: ConfidenceStore;
  private readonly now: () => string;
  private questionSet?: QuestionSet;
  private questionsById = new Map<string, Question>();
  private status: QuestionsStatus;
  private currentMode: Mode;
  private agent: boolean;
  private agentLabel?: string;
  private chosenDepth?: Depth;
  private answers = new Map<string, AnswerState>();
  private comments: DraftComment[] = [];
  private explored = new Set<string>();
  private familiarityOf = new Map<string, Familiarity>();
  private gate?: { nodeId: string; step: Gate['step'] };
  /** The question answered at each territory's gate: it stays the gate question, and finishing it explores the territory. */
  private gateAnswers = new Map<string, string>();
  private draftingPending = false;
  private postState: PostState;
  private posted = new Set<string>();
  /** Comments a post may have delivered before it failed without a clear answer (a timeout, a 5xx). */
  private maybePosted = new Set<string>();
  /** Comment ids handed to the host by the last post effect. */
  private postingIds?: string[];
  private nextComment = 1;
  private readonly headOid?: string;

  constructor(opts: ReviewModelOptions) {
    this.index = new GraphIndex(opts.graph);
    this.confidence = opts.confidence;
    this.now = opts.now;
    this.status = clone(opts.questionsStatus);
    this.currentMode = opts.mode === 'didactic' ? 'didactic' : 'fast';
    this.agent = opts.agentAvailable;
    this.agentLabel = cleanAgentName(opts.agentName);
    this.postState = { target: clone(opts.post), status: 'idle' };
    if (typeof opts.headOid === 'string' && OID.test(opts.headOid)) this.headOid = opts.headOid;
    this.useQuestions(opts.questions);
    const saved = parsePersistedReview(opts.persisted);
    if (saved) this.restore(saved);
    this.dropStaleAnswers();
  }

  // ---- reading ---------------------------------------------------------------------------------

  get mode(): Mode {
    return this.currentMode;
  }

  get agentAvailable(): boolean {
    return this.agent;
  }

  /** The depth questions are filtered by: the reviewer's choice, else the proposal. */
  get depth(): Depth {
    return this.chosenDepth ?? this.questionSet?.depth.proposed ?? DEFAULT_DEPTH;
  }

  get graph(): ReviewGraph {
    return this.index.graph;
  }

  /** A question by id, including a territory's synthetic gate question. */
  question(id: string): Question | undefined {
    const q = this.findQuestion(id);
    return q && clone(q);
  }

  comment(id: string): DraftComment | undefined {
    const c = this.comments.find((x) => x.id === id);
    return c && clone(c);
  }

  /** Answered questions at the chosen depth, in asking order: input for the `draftComments` task. */
  answered(): { question: Question; answer: AnswerState }[] {
    return this.orderedQuestions()
      .filter((q) => this.answers.get(q.id)?.attempts.length)
      .map((q) => ({ question: clone(q), answer: clone(this.answers.get(q.id)!) }));
  }

  /** An open understand answer to this question would be graded by the agent (costs a few cents). */
  needsAgentGrading(questionId: string): boolean {
    const q = this.findQuestion(questionId);
    return !!q && this.agent && !q.choices && q.purpose === 'understand' && !isGateQuestionId(q.id);
  }

  /** The private confidence key for the territory a node belongs to (an external: the territory it's grouped with). */
  modulePathOf(nodeId: string): string {
    return modulePath(this.index, this.index.groupOf(nodeId));
  }

  /** Accepted comments with a body that haven't been posted yet: what a post would send. */
  postable(): DraftComment[] {
    return clone(this.comments.filter((c) => c.status === 'accepted' && c.body.trim() && !this.posted.has(c.id)));
  }

  isPosted(commentId: string): boolean {
    return this.posted.has(commentId);
  }

  /** An earlier post that may have delivered this comment ended without a clear answer. */
  mayBePosted(commentId: string): boolean {
    return this.maybePosted.has(commentId);
  }

  /**
   * What the running post sends, read when it is sent: the last post effect's comments that are
   * still accepted, with a body, and not posted meanwhile (by another review of this PR, say).
   */
  postingComments(): DraftComment[] {
    const ids = new Set(this.postState.status === 'posting' ? (this.postingIds ?? []) : []);
    return clone(this.comments.filter((c) => ids.has(c.id) && c.status === 'accepted' && c.body.trim() && !this.posted.has(c.id)));
  }

  snapshot(): ReviewSnapshot {
    const questions = this.orderedQuestions();
    const territories = this.index.territories.map((t) => {
      const mine = questions.filter((q) => this.index.groupOf(q.nodeId) === t.id);
      const familiarity = this.familiarityOf.get(t.id);
      return {
        nodeId: t.id,
        explored: this.explored.has(t.id),
        ...(familiarity ? { familiarity } : {}),
        // 0 until there's a record: the reviewer hasn't said how familiar they are yet.
        confidence: this.confidence.get(modulePath(this.index, t.id))?.confidence ?? 0,
        questionsDone: mine.filter((q) => this.answers.get(q.id)?.done).length,
        questionsTotal: mine.length,
      };
    });
    const set = this.questionSet;
    const snap: ReviewSnapshot = {
      mode: this.currentMode,
      depth: {
        proposed: set?.depth.proposed ?? DEFAULT_DEPTH,
        why: set?.depth.why ?? '',
        chosen: this.depth,
        ...(set ? { counts: Object.fromEntries(DEPTHS.map((d) => [d, [...this.questionsById.values()].filter((q) => includesDepth(d, q.depth)).length])) } : {}),
      },
      questions,
      answers: Object.fromEntries(this.answers),
      // The webview greys out what was posted; the ids themselves are persisted, not the flag.
      comments: this.comments.map((c) => {
        const out: DraftComment = { ...c };
        if (this.posted.has(c.id)) out.posted = true;
        if (this.isOutdated(c)) out.outdated = true;
        return out;
      }),
      territories,
      coverage: { explored: territories.filter((t) => t.explored).length, total: territories.length },
      questionsStatus: this.status,
      agentAvailable: this.agent,
      ...(this.agentLabel ? { agentName: this.agentLabel } : {}),
      post: this.postState,
    };
    if (this.gate) {
      const g: Gate = { nodeId: this.gate.nodeId, step: this.gate.step };
      if (g.step === 'predict') {
        // Undefined while the agent is still writing questions: the gate waits rather than swap questions later.
        const qid = this.gateQuestionOf(this.gate.nodeId, questions);
        if (qid) g.questionId = qid;
      }
      snap.gate = g;
    }
    if (this.draftingPending) snap.draftingPending = true;
    return clone(snap);
  }

  /** What to keep per PR. Work in flight (agent grading, thread replies) is left out: it can't resume. */
  persisted(): PersistedReview {
    const answers: Record<string, AnswerState> = {};
    for (const [id, a] of this.answers) {
      const copy = clone(a);
      if (copy.pending) {
        copy.attempts.pop(); // the placeholder for the answer being graded
        delete copy.pending;
      }
      if (!copy.attempts.length) continue;
      put(answers, id, copy);
    }
    const comments = this.comments.map((c) => {
      const copy = clone(c);
      delete copy.threadPending;
      return copy;
    });
    const familiarity: Record<string, Familiarity> = {};
    for (const [id, f] of this.familiarityOf) put(familiarity, id, f);
    const out: PersistedReview = { version: 1, answers, comments, explored: [...this.explored], familiarity };
    if (this.chosenDepth) out.chosenDepth = this.chosenDepth;
    const posted = this.comments.filter((c) => this.posted.has(c.id)).map((c) => c.id);
    if (posted.length) out.posted = posted;
    const maybe = this.comments.filter((c) => this.maybePosted.has(c.id)).map((c) => c.id);
    if (maybe.length) out.maybePosted = maybe;
    return out;
  }

  // ---- webview actions -------------------------------------------------------------------------

  /** Dispatches a webview ReviewAction to the method below with the same name. */
  apply(action: ReviewAction): ReviewEffect {
    switch (action.type) {
      case 'setMode':
        return this.setMode(action.mode);
      case 'setDepth':
        return this.setDepth(action.depth);
      case 'enter':
        return this.enter(action.nodeId);
      case 'familiarity':
        return this.familiarity(action.nodeId, action.level);
      case 'cancelGate':
        return this.cancelGate();
      case 'answer':
        return this.answer(action.questionId, action.choiceId, action.text);
      case 'selfCheck':
        return this.selfCheck(action.questionId, action.gotIt);
      case 'commentAction':
        return this.commentAction(action.id, action.action);
      case 'amend':
        return this.amend(action.id, action.body);
      case 'thread':
        return this.thread(action.id, action.text);
      case 'adoptProposal':
        return this.adoptProposal(action.id, action.index);
      case 'addNote':
        return this.addNote(action.text, action.nodeId);
      case 'draftWithAgent':
        return this.draftWithAgent();
      case 'post':
        return this.requestPost();
      case 'exportReview':
        return { kind: 'export' };
      default:
        return NO_EFFECT;
    }
  }

  setMode(mode: Mode): ReviewEffect {
    if (mode !== 'fast' && mode !== 'didactic') return NO_EFFECT;
    this.currentMode = mode;
    if (mode === 'fast') this.gate = undefined;
    return NO_EFFECT;
  }

  setDepth(depth: Depth): ReviewEffect {
    if (!isDepth(depth)) return NO_EFFECT;
    this.chosenDepth = depth;
    this.refreshExplored();
    this.settleGate();
    return NO_EFFECT;
  }

  /** Didactic: open the gate into a fogged territory. Familiarity first, unless already known. */
  enter(nodeId: string): ReviewEffect {
    if (this.currentMode !== 'didactic' || !this.index.isTerritory(nodeId) || this.explored.has(nodeId)) return NO_EFFECT;
    if (this.gate?.nodeId !== nodeId) {
      const known = this.familiarityOf.has(nodeId) || !!this.confidence.get(modulePath(this.index, nodeId));
      this.gate = { nodeId, step: known ? 'predict' : 'familiarity' };
    }
    // A prediction made earlier (say in fast mode) already counts: the territory opens at once.
    this.refreshExplored();
    return NO_EFFECT;
  }

  /** Records how familiar the reviewer says they are; seeds confidence if there's no stored record. */
  familiarity(nodeId: string, level: Familiarity): ReviewEffect {
    if (!this.index.isTerritory(nodeId) || !FAMILIARITIES.includes(level)) return NO_EFFECT;
    this.familiarityOf.set(nodeId, level);
    const path = modulePath(this.index, nodeId);
    if (!this.confidence.get(path)) this.confidence.set(path, { confidence: FAMILIARITY_START[level], lastTouched: this.now() });
    if (this.gate?.nodeId === nodeId && this.gate.step === 'familiarity') this.gate.step = 'predict';
    this.refreshExplored();
    return NO_EFFECT;
  }

  cancelGate(): ReviewEffect {
    this.gate = undefined;
    return NO_EFFECT;
  }

  answer(questionId: string, choiceId?: string, text?: string): ReviewEffect {
    const q = this.orderedQuestions().find((x) => x.id === questionId);
    if (!q || !this.mayAnswer(q)) return NO_EFFECT;
    const prior = this.answers.get(q.id);
    if (prior?.pending || prior?.awaitingSelfCheck) return NO_EFFECT;
    // Judgements can be changed (the draft follows); graded answers and predictions can't.
    if (prior?.done && (q.purpose !== 'judge' || isGateQuestionId(q.id))) return NO_EFFECT;
    const state: AnswerState = prior ?? { questionId: q.id, attempts: [], done: false };
    state.questionKey = questionKey(q);
    const atGate = this.gate?.step === 'predict' && this.gateQuestionOf(this.gate.nodeId) === q.id ? this.gate.nodeId : undefined;
    const at = this.now();
    let effect: ReviewEffect = NO_EFFECT;

    if (q.choices) {
      const choice = q.choices.find((c) => c.id === choiceId);
      if (!choice) return NO_EFFECT;
      if (q.purpose === 'judge') {
        if (state.attempts[state.attempts.length - 1]?.choiceId === choice.id) return NO_EFFECT;
        // A judgement is never graded: only the current call is kept, not a log of earlier ones.
        state.attempts = [{ at, choiceId: choice.id, verdict: 'noted', reply: choice.explain, by: 'choice' }];
        state.done = true;
        this.draftFromQuestion(q, choice.id, choice.comment);
      } else if (choice.correct) {
        state.attempts.push({ at, choiceId: choice.id, verdict: 'correct', reply: choice.explain, by: 'choice' });
        state.done = true;
        this.touchConfidence(q, state.attempts.length === 1 ? 'firstTry' : 'secondTry');
      } else if (!state.attempts.length && q.hint?.trim()) {
        // Socratic: a question back, and another try.
        state.attempts.push({ at, choiceId: choice.id, verdict: 'incorrect', reply: q.hint.trim(), by: 'choice' });
      } else {
        state.attempts.push({ at, choiceId: choice.id, verdict: 'incorrect', reply: finalExplanation(q.choices, choice), by: 'choice' });
        state.done = true;
        this.touchConfidence(q, 'incorrect');
      }
    } else {
      const answer = typeof text === 'string' ? text.trim() : '';
      if (!answer) return NO_EFFECT;
      if (q.purpose === 'judge') {
        state.attempts = [{ at, text: answer, verdict: 'noted', reply: isGateQuestionId(q.id) ? NOTED_PREDICTION_REPLY : '', by: 'self' }];
        state.done = true;
      } else if (this.agent) {
        // Placeholder until the agent's verdict arrives (pending marks it as ungraded).
        state.attempts.push({ at, text: answer, verdict: 'noted', reply: '', by: 'agent' });
        state.pending = true;
        effect = { kind: 'evaluate', questionId: q.id, attempt: state.attempts.length, text: answer };
      } else if (q.reference?.trim()) {
        state.attempts.push({ at, text: answer, verdict: 'noted', reply: q.reference.trim(), by: 'self' });
        state.awaitingSelfCheck = true;
      } else {
        // Nothing to compare with: keep the answer, grade nothing.
        state.attempts.push({ at, text: answer, verdict: 'noted', reply: '', by: 'self' });
        state.done = true;
      }
    }

    this.answers.set(q.id, state);
    if (atGate) this.gateAnswers.set(atGate, q.id);
    this.refreshExplored();
    return effect;
  }

  /** No agent: the reviewer compared their open answer with the reference. */
  selfCheck(questionId: string, gotIt: boolean): ReviewEffect {
    const state = this.answers.get(questionId);
    const last = state?.attempts[state.attempts.length - 1];
    if (!state?.awaitingSelfCheck || !last) return NO_EFFECT;
    last.verdict = gotIt === true ? 'correct' : 'incorrect';
    last.by = 'self';
    delete state.awaitingSelfCheck;
    state.done = true;
    const q = this.findQuestion(questionId);
    if (q) this.touchConfidence(q, gotIt === true ? (state.attempts.length === 1 ? 'firstTry' : 'secondTry') : 'incorrect');
    this.refreshExplored();
    return NO_EFFECT;
  }

  commentAction(id: string, action: 'accept' | 'reject' | 'reopen'): ReviewEffect {
    const c = this.comments.find((x) => x.id === id);
    const status: CommentStatus | undefined = action === 'accept' ? 'accepted' : action === 'reject' ? 'rejected' : action === 'reopen' ? 'draft' : undefined;
    if (c && status && !this.isLocked(c.id)) c.status = status;
    return NO_EFFECT;
  }

  amend(id: string, body: string): ReviewEffect {
    const c = this.comments.find((x) => x.id === id);
    const text = typeof body === 'string' ? body.trim() : '';
    if (!c || !text || this.isLocked(c.id)) return NO_EFFECT;
    if (text !== c.body) {
      c.body = text;
      c.amended = true;
    }
    return NO_EFFECT;
  }

  /** The reviewer writes in a comment's thread; the agent replies (agent-sourced reviews only). */
  thread(id: string, text: string): ReviewEffect {
    const c = this.comments.find((x) => x.id === id);
    const message = typeof text === 'string' ? text.trim() : '';
    if (!c || !message || c.threadPending || !this.agent) return NO_EFFECT;
    c.thread.push({ role: 'user', text: message });
    c.threadPending = true;
    return { kind: 'thread', commentId: c.id };
  }

  adoptProposal(id: string, index: number): ReviewEffect {
    const c = this.comments.find((x) => x.id === id);
    const msg = c && Number.isInteger(index) ? c.thread[index] : undefined;
    const proposal = msg?.role === 'agent' ? msg.proposal?.trim() : undefined;
    if (!c || !proposal || this.isLocked(c.id)) return NO_EFFECT;
    if (proposal !== c.body) {
      c.body = proposal;
      c.amended = true;
    }
    return NO_EFFECT;
  }

  /** The free-text escape hatch: a reviewer note becomes a draft comment. */
  addNote(text: string, nodeId?: string): ReviewEffect {
    const body = typeof text === 'string' ? text.trim() : '';
    if (!body) return NO_EFFECT;
    const node = nodeId !== undefined ? this.index.byId.get(nodeId) : undefined;
    // A note on a symbol sits on its first anchor; one on a module or external has no single line.
    const anchor = node && node.kind !== 'module' && node.kind !== 'external' ? node.anchors[0] : undefined;
    this.addComment({
      ...(node ? { nodeId: node.id } : {}),
      ...(anchor ? { file: anchor.file, line: anchor.startLine } : {}),
      body,
      severity: 'suggestion',
      origin: { kind: 'note' },
    });
    return NO_EFFECT;
  }

  draftWithAgent(): ReviewEffect {
    if (!this.agent || this.draftingPending) return NO_EFFECT;
    this.draftingPending = true;
    return { kind: 'draft' };
  }

  /** Post to the PR: the accepted comments not posted yet. Nothing for a target of 'none' (the sample exports instead). */
  requestPost(): ReviewEffect {
    if (this.postState.target.kind !== 'github' || this.postState.status === 'posting') return NO_EFFECT;
    const comments = this.postable();
    this.postingIds = comments.map((c) => c.id);
    return { kind: 'post', comments };
  }

  // ---- host hooks ------------------------------------------------------------------------------

  /**
   * May the host open code for this node? In didactic mode, not for a node still in fog (the
   * webview sends `enter` for a fogged territory instead). Selecting anything visible closes the
   * gate: "Continue into money" selects the territory just explored.
   */
  select(nodeId: string): boolean {
    if (!this.index.byId.has(nodeId)) return false;
    if (this.currentMode === 'didactic' && !isRevealed(this.index, this.explored, nodeId)) return false;
    this.gate = undefined;
    return true;
  }

  /** `agentName`: the agent CLI that graded it, stored with the reply (the reviewer may switch CLI later). */
  applyEvaluation(questionId: string, result: EvaluationResult, agentName?: string): ReviewEffect {
    const state = this.answers.get(questionId);
    const last = state?.attempts[state.attempts.length - 1];
    if (!state?.pending || !last) return NO_EFFECT; // stale: nothing is waiting for it
    const verdict = result?.verdict;
    if (verdict !== 'correct' && verdict !== 'partly' && verdict !== 'incorrect') return this.failEvaluation(questionId, 'The agent returned no verdict.');
    delete state.pending;
    last.verdict = verdict;
    last.reply = typeof result.reply === 'string' ? result.reply.trim() : '';
    last.by = 'agent';
    const name = cleanAgentName(agentName);
    if (name) last.agentName = name;
    else delete last.agentName;
    const n = state.attempts.length;
    const q = this.findQuestion(questionId);
    // A first wrong attempt gets a hint and another try. Otherwise the reply explains, and it's done.
    if (verdict !== 'incorrect' || n >= 2) {
      state.done = true;
      if (q) this.touchConfidence(q, verdict === 'correct' ? (n === 1 ? 'firstTry' : 'secondTry') : verdict === 'partly' ? 'partly' : 'incorrect');
    }
    if (q && result.comment) this.draftFromQuestion(q, undefined, result.comment);
    this.refreshExplored();
    return NO_EFFECT;
  }

  /**
   * The agent couldn't grade (expired login, timeout…). Falls back to a self-check against the
   * reference so the review can go on; without one the answer is kept ungraded. The host reports
   * `message` itself.
   */
  failEvaluation(questionId: string, _message: string): ReviewEffect {
    const state = this.answers.get(questionId);
    const last = state?.attempts[state.attempts.length - 1];
    if (!state?.pending || !last) return NO_EFFECT;
    delete state.pending;
    const reference = this.findQuestion(questionId)?.reference?.trim();
    last.by = 'self';
    last.verdict = 'noted';
    if (reference) {
      last.reply = reference;
      state.awaitingSelfCheck = true;
    } else {
      last.reply = '';
      state.done = true;
    }
    this.refreshExplored();
    return NO_EFFECT;
  }

  /**
   * The grading was cancelled (the review was closed or re-run): the answer goes back to
   * unanswered, so it can be graded later. Never a self-check, which would show the reference.
   */
  dropEvaluation(questionId: string): ReviewEffect {
    const state = this.answers.get(questionId);
    if (!state?.pending) return NO_EFFECT;
    state.attempts.pop();
    delete state.pending;
    if (!state.attempts.length) this.answers.delete(questionId);
    this.refreshExplored();
    return NO_EFFECT;
  }

  /** `agentName`: the agent CLI that replied, stored with the message. */
  applyThreadReply(commentId: string, reply: ThreadReply, agentName?: string): ReviewEffect {
    const c = this.comments.find((x) => x.id === commentId);
    if (!c?.threadPending) return NO_EFFECT;
    const name = cleanAgentName(agentName);
    const msg: ThreadMessage = { role: 'agent', text: typeof reply?.reply === 'string' ? reply.reply.trim() : '', ...(name ? { agentName: name } : {}) };
    const proposal = typeof reply?.proposal === 'string' ? reply.proposal.trim() : '';
    if (proposal) msg.proposal = proposal;
    c.thread.push(msg);
    delete c.threadPending;
    return NO_EFFECT;
  }

  /** The thread reply failed: `message` (already safe, plain text) is shown in the thread as the agent's turn. */
  failThread(commentId: string, message: string, agentName?: string): ReviewEffect {
    const c = this.comments.find((x) => x.id === commentId);
    if (!c?.threadPending) return NO_EFFECT;
    const name = cleanAgentName(agentName);
    c.thread.push({ role: 'agent', text: typeof message === 'string' ? message : '', ...(name ? { agentName: name } : {}) });
    delete c.threadPending;
    return NO_EFFECT;
  }

  /** New comments from the agent's draftComments task. Exact repeats of existing comments are skipped. */
  /** `agentName`: the agent CLI that drafted them, stored with each comment. */
  applyAgentDrafts(seeds: readonly AgentDraftSeed[], agentName?: string): ReviewEffect {
    this.draftingPending = false;
    const name = cleanAgentName(agentName);
    for (const s of Array.isArray(seeds) ? seeds : []) {
      const seed = cleanSeed(s);
      if (!seed) continue;
      const dup = this.comments.some((c) => c.body.trim() === seed.body && c.file === seed.file && c.line === seed.line);
      if (dup) continue;
      const nodeId = typeof s.nodeId === 'string' && this.index.byId.has(s.nodeId) ? s.nodeId : undefined;
      this.addComment({ ...(nodeId ? { nodeId } : {}), ...seed, origin: { kind: 'agent', ...(name ? { agentName: name } : {}) } });
    }
    return NO_EFFECT;
  }

  failDrafting(_message: string): ReviewEffect {
    this.draftingPending = false;
    return NO_EFFECT;
  }

  /**
   * The agent's questions pass finished (or failed, or restarted). Answers are kept by question id,
   * as long as the question with that id is still the one they answered.
   */
  setQuestions(questions: QuestionSet | undefined, status: QuestionsStatus): ReviewEffect {
    this.useQuestions(questions);
    this.status = clone(status);
    this.dropStaleAnswers();
    this.refreshExplored();
    this.settleGate();
    return NO_EFFECT;
  }

  /**
   * The host's progress posting. 'posted' marks the comments of the last post effect as posted:
   * those in `sent` when given (what actually went to GitHub). An 'error' that is `uncertain` (the
   * request may have reached GitHub) marks them as maybe posted, so the next post warns.
   */
  setPostState(state: PostState, outcome: { sent?: readonly string[]; uncertain?: boolean } = {}): ReviewEffect {
    const next = clone(state);
    const sent = outcome.sent ? new Set(outcome.sent) : undefined;
    const ids = (this.postingIds ?? []).filter((id) => !sent || sent.has(id));
    if (next.status === 'posted') {
      for (const id of ids) {
        this.posted.add(id);
        this.maybePosted.delete(id);
      }
    }
    if (next.status === 'error' && outcome.uncertain === true) for (const id of ids) this.maybePosted.add(id);
    if (next.status !== 'posting') this.postingIds = undefined;
    this.postState = next;
    return NO_EFFECT;
  }

  /**
   * Posted marks another review of this PR stored meanwhile (an earlier panel whose post finished
   * late): they apply to the comments here that are the same comment.
   */
  adoptPostedMarks(stored: unknown): ReviewEffect {
    const saved = parsePersistedReview(stored);
    if (!saved) return NO_EFFECT;
    const theirs = new Map(saved.comments.map((c) => [c.id, c]));
    const same = (id: string) => {
      const a = this.comments.find((c) => c.id === id);
      const b = theirs.get(id);
      return !!a && !!b && sameComment(a, b);
    };
    for (const id of saved.posted ?? []) {
      if (!same(id)) continue;
      this.posted.add(id);
      this.maybePosted.delete(id);
    }
    for (const id of saved.maybePosted ?? []) if (same(id) && !this.posted.has(id)) this.maybePosted.add(id);
    return NO_EFFECT;
  }

  /** E.g. the agent's login expired: later open answers fall back to self-checks. */
  setAgentAvailable(available: boolean): ReviewEffect {
    this.agent = available;
    return NO_EFFECT;
  }

  /** The reviewer chose another agent CLI: later agent steps go to it, and the wording follows. */
  setAgentName(name: string | undefined): ReviewEffect {
    this.agentLabel = cleanAgentName(name);
    return NO_EFFECT;
  }

  // ---- internals -------------------------------------------------------------------------------

  /** Posted comments are on GitHub, and those being posted are what the confirmation shows: neither changes. */
  private isLocked(id: string): boolean {
    return this.posted.has(id) || (this.postState.status === 'posting' && !!this.postingIds?.includes(id));
  }

  /** A comment on a line of an earlier commit than the one under review (or of one not recorded). */
  private isOutdated(c: DraftComment): boolean {
    return c.file !== undefined && this.headOid !== undefined && c.commit !== this.headOid;
  }

  /** Re-answering may drop this draft: the reviewer hasn't accepted, edited or (maybe) posted it. */
  private isReplaceable(c: DraftComment): boolean {
    return c.status !== 'accepted' && !c.amended && !this.posted.has(c.id) && !this.maybePosted.has(c.id);
  }

  /**
   * Answers to a question that has since changed under the same id (a re-run's new set) are dropped,
   * with the drafts they made that are still only drafts. Answers to ids the set doesn't have are kept.
   */
  private dropStaleAnswers(): void {
    for (const [id, a] of [...this.answers]) {
      const q = isGateQuestionId(id) ? this.syntheticGate(id.slice(GATE_QUESTION_PREFIX.length)) : this.questionsById.get(id);
      if (!q || a.questionKey === questionKey(q)) continue;
      this.answers.delete(id);
      for (const [t, qid] of [...this.gateAnswers]) if (qid === id) this.gateAnswers.delete(t);
      this.comments = this.comments.filter((c) => !(c.origin.kind === 'question' && c.origin.questionId === id && this.isReplaceable(c)));
    }
  }

  /**
   * After the depth or the questions change: a gate left open on a territory just explored has
   * nothing to show if its question is no longer listed, so it closes (back to the map).
   */
  private settleGate(): void {
    const g = this.gate;
    if (!g || g.step !== 'predict' || !this.explored.has(g.nodeId)) return;
    const sticky = this.gateAnswers.get(g.nodeId);
    if (!sticky || !this.orderedQuestions().some((q) => q.id === sticky)) this.gate = undefined;
  }

  private useQuestions(set: QuestionSet | undefined): void {
    this.questionSet = set && clone(set);
    this.questionsById = new Map();
    for (const q of this.questionSet?.questions ?? []) {
      // "gate:" ids are reserved for the synthetic gate questions.
      if (!this.questionsById.has(q.id) && !isGateQuestionId(q.id)) this.questionsById.set(q.id, q);
    }
  }

  private syntheticGate(nodeId: string): Question | undefined {
    const node = this.index.byId.get(nodeId);
    if (!node || !this.index.isTerritory(nodeId)) return undefined;
    return {
      id: gateQuestionId(nodeId),
      nodeId,
      stage: 'predict',
      purpose: 'judge',
      depth: 'skim',
      prompt: `What do you expect this change to affect in ${node.label}?`,
    };
  }

  private findQuestion(id: string): Question | undefined {
    if (!isGateQuestionId(id)) return this.questionsById.get(id);
    if (this.currentMode !== 'didactic' && !this.answers.has(id)) return undefined;
    return this.syntheticGate(id.slice(GATE_QUESTION_PREFIX.length));
  }

  private hasPredict(territory: string, ordered: readonly Question[]): boolean {
    return ordered.some((q) => q.stage === 'predict' && !isGateQuestionId(q.id) && this.index.territoryOf(q.nodeId) === territory);
  }

  /**
   * Real questions at the chosen depth, in asking order, plus synthetic gate questions: answered
   * ones (a prediction stays visible), and in didactic mode one for each fogged territory with no
   * predict question of its own, once the questions are in.
   */
  private orderedQuestions(): Question[] {
    const real = orderQuestions(this.index, [...this.questionsById.values()], this.depth);
    const extra: Question[] = [];
    const waiting = this.status.state === 'loading';
    for (const t of this.index.territories) {
      const answered = this.answers.has(gateQuestionId(t.id));
      const needed = this.currentMode === 'didactic' && !waiting && !this.explored.has(t.id) && !this.hasPredict(t.id, real);
      if (answered || needed) extra.push(this.syntheticGate(t.id)!);
    }
    return extra.length ? orderQuestions(this.index, [...real, ...extra], this.depth) : real;
  }

  /**
   * The gate's predict question: the one already answered there, else the territory's first predict
   * question (on the module or a descendant) at the chosen depth, else the synthetic one. Undefined
   * while questions are loading and there's no real one yet.
   */
  private gateQuestionOf(nodeId: string, ordered = this.orderedQuestions()): string | undefined {
    const sticky = this.gateAnswers.get(nodeId);
    if (sticky && ordered.some((q) => q.id === sticky)) return sticky;
    const first = ordered.find((q) => q.stage === 'predict' && !isGateQuestionId(q.id) && this.index.territoryOf(q.nodeId) === nodeId);
    if (first) return first.id;
    return this.status.state === 'loading' ? undefined : gateQuestionId(nodeId);
  }

  /** Didactic: questions in fog can't be answered, except the gate's own question, which is how a territory is entered. */
  private mayAnswer(q: Question): boolean {
    if (this.currentMode !== 'didactic') return !isGateQuestionId(q.id);
    if (!isGateQuestionId(q.id) && isRevealed(this.index, this.explored, q.nodeId)) return true;
    const territory = this.index.territoryOf(q.nodeId);
    return !!territory && this.gate?.nodeId === territory && this.gate.step === 'predict' && this.gateQuestionOf(territory) === q.id;
  }

  /**
   * A territory is explored once the question answered at its gate is done, even if the answer was
   * graded after the gate closed. The open gate's question may also be done already (answered in
   * fast mode, say). The gate stays open to show the feedback.
   */
  private refreshExplored(): void {
    for (const [t, qid] of this.gateAnswers) if (this.answers.get(qid)?.done) this.explored.add(t);
    const g = this.gate;
    if (!g || g.step !== 'predict' || this.currentMode !== 'didactic' || this.explored.has(g.nodeId)) return;
    const qid = this.gateQuestionOf(g.nodeId);
    if (qid && this.answers.get(qid)?.done) {
      this.gateAnswers.set(g.nodeId, qid);
      this.explored.add(g.nodeId);
    }
  }

  private touchConfidence(q: Question, outcome: UnderstandOutcome): void {
    if (q.purpose !== 'understand' || isGateQuestionId(q.id)) return;
    const territory = this.index.groupOf(q.nodeId);
    if (!this.index.isTerritory(territory)) return;
    const path = modulePath(this.index, territory);
    // No record means the reviewer never told us their familiarity: don't invent a starting point.
    const record = this.confidence.get(path);
    if (!record) return;
    this.confidence.set(path, { confidence: adjustConfidence(record.confidence, outcome), lastTouched: this.now() });
  }

  /**
   * A judge choice (or an evaluation) drafts a comment. Re-answering replaces the question's earlier
   * drafts, except those the reviewer accepted, amended or posted; picking a choice whose draft
   * survives keeps that draft (and still drops the other choices' replaceable drafts).
   */
  private draftFromQuestion(q: Question, choiceId: string | undefined, rawSeed: CommentSeed | undefined): void {
    const fromChoice = choiceId !== undefined;
    const earlier = this.comments.filter((c) => c.origin.kind === 'question' && c.origin.questionId === q.id && (c.origin.choiceId !== undefined) === fromChoice);
    const sameChoice = (c: DraftComment) => fromChoice && c.origin.kind === 'question' && c.origin.choiceId === choiceId;
    const replaced = new Set(earlier.filter((c) => !sameChoice(c) && this.isReplaceable(c)));
    this.comments = this.comments.filter((c) => !replaced.has(c));
    if (earlier.some(sameChoice)) return;
    const seed = rawSeed && cleanSeed(rawSeed);
    if (!seed) return;
    this.addComment({ nodeId: q.nodeId, ...seed, origin: { kind: 'question', questionId: q.id, ...(fromChoice ? { choiceId } : {}) } });
  }

  private addComment(c: Pick<DraftComment, 'nodeId' | 'file' | 'line' | 'body' | 'severity' | 'origin'>): void {
    const comment: DraftComment = { id: this.freshCommentId(), ...c, status: 'draft', amended: false, thread: [] };
    if (comment.nodeId === undefined) delete comment.nodeId;
    if (comment.file === undefined) delete comment.file;
    if (comment.line === undefined) delete comment.line;
    // Its line is a line of the commit under review, whatever is checked out when it's posted.
    if (comment.file !== undefined && this.headOid) comment.commit = this.headOid;
    this.comments.push(comment);
  }

  /** The next unused "c<n>". Ids are never repeated, even after a stored id near the end of the safe integers. */
  private freshCommentId(): string {
    for (;;) {
      if (!Number.isSafeInteger(this.nextComment + 1)) this.nextComment = 1;
      const id = `c${this.nextComment++}`;
      if (!this.comments.some((x) => x.id === id)) return id;
    }
  }

  private restore(saved: PersistedReview): void {
    if (saved.chosenDepth) this.chosenDepth = saved.chosenDepth;
    for (const [id, a] of Object.entries(saved.answers)) this.answers.set(id, a);
    this.comments = saved.comments;
    for (const id of saved.explored) if (this.index.isTerritory(id)) this.explored.add(id);
    for (const [id, f] of Object.entries(saved.familiarity)) if (this.index.isTerritory(id)) this.familiarityOf.set(id, f);
    const ids = new Set(this.comments.map((c) => c.id));
    for (const id of saved.posted ?? []) if (ids.has(id)) this.posted.add(id);
    for (const id of saved.maybePosted ?? []) if (ids.has(id) && !this.posted.has(id)) this.maybePosted.add(id);
    for (const c of this.comments) {
      const n = /^c(\d+)$/.exec(c.id);
      // A corrupt id ("c" and 400 digits) must not push the counter past where ++ still counts.
      const next = n ? Number(n[1]) + 1 : NaN;
      if (Number.isSafeInteger(next)) this.nextComment = Math.max(this.nextComment, next);
    }
  }
}

/** Chosen wrong answer, then the right one: the explanation shown when the question is done. */
function finalExplanation(choices: readonly Choice[], chosen: Choice): string {
  const parts = [chosen.explain.trim()];
  for (const c of choices) if (c.correct && c !== chosen) parts.push(`Answer: ${c.text.trim()} — ${c.explain.trim()}`);
  return parts.filter(Boolean).join('\n\n');
}

/** A comment seed with an empty body, a bad severity or a nonsense line fixed or dropped. */
function cleanSeed(seed: CommentSeed | undefined): Pick<DraftComment, 'file' | 'line' | 'body' | 'severity'> | undefined {
  const body = typeof seed?.body === 'string' ? seed.body.trim() : '';
  if (!seed || !body) return undefined;
  const out: Pick<DraftComment, 'file' | 'line' | 'body' | 'severity'> = { body, severity: SEVERITIES.includes(seed.severity) ? seed.severity : 'suggestion' };
  if (typeof seed.file === 'string' && seed.file.trim()) {
    out.file = seed.file.trim();
    if (typeof seed.line === 'number' && Number.isInteger(seed.line) && seed.line >= 1) out.line = seed.line;
  }
  return out;
}

// ---- persisted state, read defensively ---------------------------------------------------------

/** One short line (it is shown in sentences like "Codex is replying…"), or undefined. */
function cleanAgentName(name: unknown): string | undefined {
  if (typeof name !== 'string') return undefined;
  const flat = name
    .replace(/[\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, '')
    .replace(/[\s\x00-\x1f\x7f]+/g, ' ')
    .trim();
  return flat ? flat.slice(0, 40).trim() : undefined;
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

const str = (v: unknown): v is string => typeof v === 'string';

function parseAttempt(v: unknown): Attempt | undefined {
  if (!isObj(v) || !str(v.at) || !str(v.reply) || !VERDICTS.includes(v.verdict as Verdict)) return undefined;
  if (v.by !== 'choice' && v.by !== 'agent' && v.by !== 'self') return undefined;
  const a: Attempt = { at: v.at, verdict: v.verdict as Verdict, reply: v.reply, by: v.by };
  const name = v.by === 'agent' ? cleanAgentName(v.agentName) : undefined;
  if (name) a.agentName = name;
  if (str(v.choiceId)) a.choiceId = v.choiceId;
  if (str(v.text)) a.text = v.text;
  return a;
}

function parseAnswer(id: string, v: unknown): AnswerState | undefined {
  if (!isObj(v) || !Array.isArray(v.attempts)) return undefined;
  const attempts = v.attempts.map(parseAttempt);
  if (!attempts.length || attempts.some((a) => !a)) return undefined;
  const a: AnswerState = { questionId: id, attempts: attempts as Attempt[], done: v.done === true };
  if (v.pending === true) {
    // Saved mid-grading: the grading is lost, so drop its placeholder.
    a.attempts.pop();
    if (!a.attempts.length) return undefined;
  } else if (v.awaitingSelfCheck === true && !a.done) {
    a.awaitingSelfCheck = true;
  }
  // Older stores logged every change of a judgement; only the latest tries matter.
  if (a.attempts.length > MAX_ATTEMPTS) a.attempts = a.attempts.slice(-MAX_ATTEMPTS);
  if (str(v.questionKey)) a.questionKey = v.questionKey;
  return a;
}

function parseComment(v: unknown): DraftComment | undefined {
  if (!isObj(v) || !str(v.id) || !str(v.body) || !SEVERITIES.includes(v.severity as CommentSeverity) || !STATUSES.includes(v.status as CommentStatus)) return undefined;
  const o = v.origin;
  let origin: DraftComment['origin'];
  if (isObj(o) && o.kind === 'question' && str(o.questionId)) origin = { kind: 'question', questionId: o.questionId, ...(str(o.choiceId) ? { choiceId: o.choiceId } : {}) };
  else if (isObj(o) && o.kind === 'agent') {
    const name = cleanAgentName(o.agentName);
    origin = { kind: 'agent', ...(name ? { agentName: name } : {}) };
  } else if (isObj(o) && o.kind === 'note') origin = { kind: 'note' };
  else return undefined;
  const thread: ThreadMessage[] = [];
  for (const m of Array.isArray(v.thread) ? v.thread : []) {
    if (!isObj(m) || (m.role !== 'user' && m.role !== 'agent') || !str(m.text)) continue;
    const name = m.role === 'agent' ? cleanAgentName(m.agentName) : undefined;
    thread.push({ role: m.role, text: m.text, ...(m.role === 'agent' && str(m.proposal) ? { proposal: m.proposal } : {}), ...(name ? { agentName: name } : {}) });
  }
  const c: DraftComment = { id: v.id, body: v.body, severity: v.severity as CommentSeverity, origin, status: v.status as CommentStatus, amended: v.amended === true, thread };
  if (str(v.nodeId)) c.nodeId = v.nodeId;
  if (str(v.file)) c.file = v.file;
  if (typeof v.line === 'number' && Number.isInteger(v.line) && v.line >= 1) c.line = v.line;
  if (str(v.commit) && OID.test(v.commit)) c.commit = v.commit;
  return c;
}

/** Validates a stored PersistedReview; malformed parts are dropped. Undefined if it isn't one at all. */
export function parsePersistedReview(raw: unknown): PersistedReview | undefined {
  if (!isObj(raw) || raw.version !== 1) return undefined;
  const answers: Record<string, AnswerState> = {};
  if (isObj(raw.answers)) {
    for (const [id, v] of Object.entries(raw.answers)) {
      const a = parseAnswer(id, v);
      if (a) put(answers, id, a);
    }
  }
  const comments: DraftComment[] = [];
  const ids = new Set<string>();
  for (const v of Array.isArray(raw.comments) ? raw.comments : []) {
    const c = parseComment(v);
    if (c && !ids.has(c.id)) {
      ids.add(c.id);
      comments.push(c);
    }
  }
  const explored = Array.isArray(raw.explored) ? [...new Set(raw.explored.filter(str))] : [];
  const familiarity: Record<string, Familiarity> = {};
  if (isObj(raw.familiarity)) {
    for (const [id, f] of Object.entries(raw.familiarity)) if (FAMILIARITIES.includes(f as Familiarity)) put(familiarity, id, f as Familiarity);
  }
  const out: PersistedReview = { version: 1, answers, comments, explored, familiarity };
  if (isDepth(raw.chosenDepth)) out.chosenDepth = raw.chosenDepth;
  const posted = Array.isArray(raw.posted) ? [...new Set(raw.posted.filter((id): id is string => str(id) && ids.has(id)))] : [];
  if (posted.length) out.posted = posted;
  const maybe = Array.isArray(raw.maybePosted) ? [...new Set(raw.maybePosted.filter((id): id is string => str(id) && ids.has(id) && !posted.includes(id)))] : [];
  if (maybe.length) out.maybePosted = maybe;
  return out;
}

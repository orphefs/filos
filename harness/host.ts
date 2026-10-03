// Mock extension host for the harness, bundled to dist/harness-host.js and loaded before
// dist/webview.js. It provides acquireVsCodeApi (once, like VS Code), records everything the
// webview posts in window.__hostLog and the visible "Host log", and answers the way the real host
// does: 'ready' → 'load' plus a 'review' snapshot.
//
// The review side runs the REAL ReviewModel (src/review/model.ts) over the sample graph and
// fixtures/sample-questions.json, with an in-memory confidence store. Agent effects (grading,
// thread replies, drafting) and posting are simulated with short delays and canned replies, so
// every flow can be clicked through. Nothing leaves the page: no agent, no GitHub.

import type { ReviewGraph } from '../src/contract/graph';
import type { QuestionSet } from '../src/contract/questions';
import type { HostToWebview, LoadingStep, ReviewAction, WebviewToHost } from '../src/protocol';
import { MemoryConfidenceStore, type ConfidenceRecord } from '../src/review/confidence';
import { reviewToMarkdown } from '../src/review/markdown';
import { ReviewModel, type EvaluationResult, type QuestionsStatus, type ReviewEffect } from '../src/review/model';
import type { Mode, PostTarget } from '../src/review/types';

declare global {
  interface Window {
    __hostLog: { direction: string; at: number; msg: unknown }[];
    __filosHarness: unknown;
    acquireVsCodeApi?: () => unknown;
  }
}

const GRAPH_URL = '/fixtures/sample-graph.json';
const QUESTIONS_URL = '/fixtures/sample-questions.json';
const KEYS = {
  webview: 'filos-harness-webview-state',
  view: 'filos-harness-host-state',
  review: 'filos-harness-review',
  confidence: 'filos-harness-confidence',
  options: 'filos-harness-options',
};

interface Options {
  mode: Mode;
  agent: boolean;
  /** Simulated agent calls fail (expired login): grading falls back to self-checks. */
  agentFails: boolean;
  target: 'none' | 'github';
  questions: QuestionsStatus['state'];
  /** Simulated posting fails. */
  postFails: boolean;
}

const DEFAULTS: Options = { mode: 'fast', agent: false, agentFails: false, target: 'none', questions: 'ready', postFails: false };

const SAMPLE_TARGET: PostTarget = { kind: 'none', reason: 'This is the bundled sample: there is no pull request to post to. Export the review as Markdown instead.' };
const GITHUB_TARGET: Extract<PostTarget, { kind: 'github' }> = { kind: 'github', repo: 'acme/ledger', number: 42, url: 'https://github.com/acme/ledger/pull/42' };

/** A small inline set, used only if the fixture can't be fetched. */
const FALLBACK_QUESTIONS: QuestionSet = {
  contractVersion: '0.1',
  depth: { proposed: 'skim', why: 'Fallback questions (fixtures/sample-questions.json could not be loaded).' },
  questions: [
    {
      id: 'q-fallback-predict',
      nodeId: 'money',
      stage: 'predict',
      purpose: 'understand',
      depth: 'skim',
      prompt: 'roundToCents changes its default. Who notices first?',
      choices: [
        { id: 'a', text: 'Nobody: the results are identical.', correct: false, explain: 'Ties now round to even, so some results move by a cent.' },
        { id: 'b', text: 'Every caller that relies on the default.', correct: true, explain: 'Callers inside and outside this repo inherit the new default.' },
      ],
      hint: 'Which callers pass no mode?',
    },
  ],
};

// ---- storage (sessionStorage only: per tab, gone when it closes) ------------------------------

function read<T>(key: string): T | undefined {
  try {
    const v = sessionStorage.getItem(key);
    return v ? (JSON.parse(v) as T) : undefined;
  } catch {
    return undefined;
  }
}

function write(key: string, v: unknown): void {
  try {
    sessionStorage.setItem(key, JSON.stringify(v));
  } catch {
    /* private mode: state just won't survive a reload */
  }
}

const log: Window['__hostLog'] = (window.__hostLog = []);
let options: Options = { ...DEFAULTS, ...(read<Partial<Options>>(KEYS.options) ?? {}) };
let hostView = read<{ expanded: string[]; visited: string[]; selected?: string }>(KEYS.view) ?? { expanded: [], visited: [] };
let graph: ReviewGraph | undefined;
let questionSet: QuestionSet | undefined;
let model: ReviewModel | undefined;
let confidence = new MemoryConfidenceStore(read<Record<string, ConfidenceRecord>>(KEYS.confidence) ?? {});
let acquired = false;
let source: 'fixture' | 'agent' = 'fixture';
/** The last load was a pull request review (a reload of the webview gets the same). */
let prLoaded = false;
/** Bumped by every simulated run and every manual send, so an older run stops where it is. */
let runSeq = 0;

function record(direction: string, msg: unknown): void {
  log.push({ direction, at: Date.now(), msg });
  const list = document.getElementById('host-log');
  if (!list) return;
  const li = document.createElement('li');
  li.className = direction === 'host → webview' ? 'from-host' : 'from-webview';
  const m = msg as { type?: string; graph?: ReviewGraph; review?: unknown };
  let shown: unknown = msg;
  if (m.type === 'load' && m.graph) shown = { ...m, graph: `‹${m.graph.nodes.length} nodes›` };
  if (m.type === 'review') shown = { type: 'review', review: '‹snapshot›' };
  li.textContent = `${direction}  ${JSON.stringify(shown)}`;
  list.append(li);
  while (list.childElementCount > 400) list.firstElementChild?.remove();
  list.scrollTop = list.scrollHeight;
}

function send(msg: HostToWebview): void {
  record('host → webview', msg);
  window.postMessage(msg, '*');
}

function saveOptions(): void {
  write(KEYS.options, options);
  renderOptionState();
}

// ---- fixtures and the model --------------------------------------------------------------------

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) throw new Error(`GET ${url}: ${res.status}`);
  return (await res.json()) as T;
}

async function fixtures(): Promise<ReviewGraph> {
  if (!graph) {
    graph = await fetchJson<ReviewGraph>(GRAPH_URL);
    fillSelect();
  }
  if (!questionSet) {
    try {
      questionSet = await fetchJson<QuestionSet>(QUESTIONS_URL);
    } catch (err) {
      console.warn('[harness] using the inline fallback questions:', err);
      questionSet = FALLBACK_QUESTIONS;
    }
  }
  return graph;
}

function questionsStatus(): QuestionsStatus {
  switch (options.questions) {
    case 'loading':
      return { state: 'loading' };
    case 'error':
      return { state: 'error', message: 'Claude Code could not write questions for this PR (simulated).' };
    case 'none':
      return { state: 'none', message: 'No questions for this review (simulated).' };
    default:
      return { state: 'ready' };
  }
}

function buildModel(g: ReviewGraph): ReviewModel {
  const status = questionsStatus();
  return new ReviewModel({
    graph: g,
    questions: status.state === 'ready' ? questionSet : undefined,
    questionsStatus: status,
    mode: options.mode,
    persisted: read(KEYS.review),
    confidence: {
      get: (p) => confidence.get(p),
      set: (p, v) => {
        confidence.set(p, v);
        write(KEYS.confidence, confidence.toJSON());
      },
    },
    agentAvailable: options.agent,
    post: options.target === 'github' ? GITHUB_TARGET : SAMPLE_TARGET,
    now: () => new Date().toISOString(),
  });
}

function sendReview(): void {
  if (!model) return;
  write(KEYS.review, model.persisted());
  send({ type: 'review', review: model.snapshot() });
  renderOptionState();
}

/** A pull request review is agent-sourced and posts to GitHub: the switches a real host would set. */
function becomePullRequest(): void {
  options.agent = true;
  options.target = 'github';
  saveOptions();
  model?.setAgentAvailable(true);
  model?.setPostState({ target: GITHUB_TARGET, status: 'idle' });
}

async function sendLoad(opts: { agent?: boolean; warnings?: boolean; pr?: boolean } = {}): Promise<void> {
  try {
    const g = structuredClone(await fixtures());
    source = opts.agent || opts.pr ? 'agent' : 'fixture';
    prLoaded = !!opts.pr;
    if (source === 'agent') g.generatedBy = { provider: 'claude', model: 'claude-sonnet-5', at: new Date().toISOString() };
    if (opts.pr) {
      g.pr = { ...g.pr, url: GITHUB_TARGET.url };
      becomePullRequest();
    }
    model ??= buildModel(g);
    send({
      type: 'load',
      graph: g,
      source,
      state: hostView,
      warnings: opts.warnings
        ? ['node "ext/mobile-app": externals have no anchors (ignored)', 'anchor test/round.test.ts:15-29 is in a file with no outline (no folds there)']
        : [],
    });
    sendReview();
  } catch (err) {
    send({ type: 'error', message: 'The harness could not load the fixture.', detail: String(err), actions: ['retry'] });
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function simulateRun(): Promise<void> {
  const seq = ++runSeq;
  send({ type: 'loading', message: 'Reading the PR…', detail: 'claude · feature/bankers-rounding → main' });
  await sleep(700);
  if (seq !== runSeq) return;
  send({ type: 'loading', message: 'Reading money/round.ts', detail: 'claude · feature/bankers-rounding → main' });
  await sleep(700);
  if (seq !== runSeq) return;
  await sendLoad({ agent: true });
}

// ---- simulated pull request start: steps advance while the (fake) agent works ------------------

const PR_LABEL = `${GITHUB_TARGET.repo}#${GITHUB_TARGET.number}`;
const PR_MESSAGE = `Reviewing ${PR_LABEL}…`;
const PR_DETAIL = 'claude · feature/bankers-rounding → main';

/** Each frame: [index of the active step, its live detail, the details of the steps already done]. */
const PR_STEP_LABELS = ['Fetch the pull request', 'Prepare the code', 'Comprehension pass (claude)', 'Write questions (claude)'];
const PR_DONE_DETAIL = [`#${GITHUB_TARGET.number} · 14 files · +440 −176`, 'feature/bankers-rounding at 3f2a91c', 'Graph: 14 nodes, 17 edges', '9 questions'];
const PR_FRAMES: [number, string][] = [
  [0, `gh pr view ${GITHUB_TARGET.url}`],
  [0, 'Reading the diff…'],
  [1, 'Fetching feature/bankers-rounding…'],
  [1, 'Checking out 3f2a91c in a temporary worktree'],
  [2, 'Starting claude (sonnet)…'],
  [2, 'Reading src/money/round.ts'],
  [2, 'Searching for roundToCents'],
  [2, 'Reading src/invoice/totals.ts'],
  [2, 'Writing the graph…'],
  [3, 'Reading the graph…'],
  [3, 'Writing questions for 4 modules…'],
];

function prSteps(active: number, detail: string, failed = false): LoadingStep[] {
  return PR_STEP_LABELS.map((label, i): LoadingStep => {
    if (i < active) return { label, state: 'done', detail: PR_DONE_DETAIL[i] };
    if (i === active) return { label, state: failed ? 'failed' : 'active', detail };
    return { label, state: 'pending' };
  });
}

/** @param failAt frame index at which the comprehension pass fails (expired login), or undefined to finish */
async function simulatePrRun(failAt?: number): Promise<void> {
  const seq = ++runSeq;
  for (let f = 0; f < PR_FRAMES.length; f++) {
    const [active, detail] = PR_FRAMES[f];
    if (f === failAt) {
      send({
        type: 'error',
        message: 'Your claude session has expired.',
        detail: 'claude exited with code 1:\nInvalid API key · Please run /login\n\nRun "claude auth login" in a terminal, then try again.',
        actions: ['login', 'retry', 'useFixture'],
        steps: prSteps(active, 'claude: login expired (simulated)', true),
      });
      return;
    }
    send({ type: 'loading', message: PR_MESSAGE, detail: PR_DETAIL, steps: prSteps(active, detail) });
    await sleep(active === 2 ? 900 : 650);
    if (seq !== runSeq) return;
  }
  send({ type: 'loading', message: PR_MESSAGE, detail: PR_DETAIL, steps: prSteps(PR_STEP_LABELS.length, '') });
  await sleep(400);
  if (seq !== runSeq) return;
  await sendLoad({ pr: true });
}

/** What Retry / Log in again / Re-run do: run the same kind of review again. */
let lastRun: 'branch' | 'pr' = 'branch';
function rerun(): void {
  if (lastRun === 'pr') void simulatePrRun();
  else void simulateRun();
}

// ---- simulated agent -----------------------------------------------------------------------------

const STOP = new Set(['about', 'after', 'again', 'because', 'before', 'being', 'their', 'there', 'these', 'those', 'which', 'while', 'would', 'could', 'should', 'every', 'other', 'where', 'still', 'never', 'under', 'whole', 'answer']);

function keywords(text: string): string[] {
  return [...new Set((text.toLowerCase().match(/[a-z][a-z-]{4,}/g) ?? []).filter((w) => !STOP.has(w)))];
}

function firstSentence(text: string): string {
  const m = /^.*?[.!?](\s|$)/s.exec(text.trim());
  return (m ? m[0] : text).trim();
}

/** Canned grading: how much of the reference's vocabulary the answer uses. */
function cannedEvaluation(questionId: string, attempt: number, text: string): EvaluationResult {
  const q = model?.question(questionId);
  const reference = q?.reference ?? '';
  const words = keywords(reference).slice(0, 24);
  const said = new Set(keywords(text));
  const hits = words.filter((w) => said.has(w)).length;
  const ratio = words.length ? hits / Math.min(words.length, 10) : 0;
  const verdict: EvaluationResult['verdict'] = text.trim().length < 12 ? 'incorrect' : ratio >= 0.35 ? 'correct' : ratio >= 0.15 ? 'partly' : 'incorrect';
  let reply: string;
  if (verdict === 'correct') reply = 'Yes, that covers it. (Simulated reply: the harness grades by how much of the reference your answer uses.)';
  else if (verdict === 'partly') reply = `Partly. You have some of it; the part to add: ${firstSentence(reference)}`;
  else if (attempt <= 1) reply = q?.hint ?? 'Not quite. Which callers pass no rounding mode, and what do they get now?';
  else reply = `Here is what a full answer covers. ${reference}`;
  const out: EvaluationResult = { verdict, reply };
  if (/no test|untested|missing test/i.test(text)) {
    out.comment = { file: 'src/money/round.ts', line: 18, body: 'Exact half-cent ties have no test. Could you add one that pins the new default (12.5 -> 12)?', severity: 'suggestion' };
  }
  return out;
}

function cannedThreadReply(commentId: string): { reply: string; proposal?: string } {
  const c = model?.comment(commentId);
  const asked = c?.thread[c.thread.length - 1]?.text ?? '';
  const body = c?.body.trim() ?? '';
  if (/\?\s*$/.test(asked) && !/rewrite|shorter|kinder|tone|clearer/i.test(asked)) {
    return { reply: 'Good question. The PR changes the default for every caller that passes no mode, so the comment stands; naming one concrete input would make it easier to act on. (Simulated reply.)' };
  }
  const first = firstSentence(body);
  return {
    reply: 'Here is a tighter version that names a concrete input and asks for one specific change. (Simulated reply.)',
    proposal: `${first} Could you add a test that pins the new behaviour, for example roundToCents(12.5) === 12?`,
  };
}

const DRAFTS = [
  {
    nodeId: 'invoice/applyDiscount',
    file: 'src/invoice/discount.ts',
    line: 23,
    body: 'Percentage discounts now go through Money.multiply, so they round half-even too. Is that intended for discounts, or should discounts keep half-up? (Simulated draft.)',
    severity: 'question' as const,
  },
  {
    nodeId: 'api/createInvoiceHandler',
    file: 'src/api/handlers.ts',
    line: 30,
    body: 'A request with "discountCode": null gets a 400 (unknown code "null"). Treating null like a missing code would match how most clients send it. (Simulated draft.)',
    severity: 'suggestion' as const,
  },
];

function runEffect(effect: ReviewEffect): void {
  const m = model;
  if (!m) return;
  switch (effect.kind) {
    case 'none':
      return;
    case 'evaluate':
      setTimeout(() => {
        if (options.agentFails) m.failEvaluation(effect.questionId, 'Your Claude Code login has expired (simulated).');
        else m.applyEvaluation(effect.questionId, cannedEvaluation(effect.questionId, effect.attempt, effect.text));
        sendReview();
      }, 900);
      return;
    case 'thread':
      setTimeout(() => {
        if (options.agentFails) m.failThread(effect.commentId, 'Claude Code could not reply: your login has expired (simulated). Log in again and resend.');
        else m.applyThreadReply(effect.commentId, cannedThreadReply(effect.commentId));
        sendReview();
      }, 1100);
      return;
    case 'draft':
      setTimeout(() => {
        if (options.agentFails) m.failDrafting('Claude Code could not draft comments (simulated).');
        else m.applyAgentDrafts(DRAFTS);
        sendReview();
      }, 1300);
      return;
    case 'post': {
      const target = m.snapshot().post.target;
      if (!effect.comments.length) {
        record('host (simulated)', { info: 'Nothing to post: no accepted comments that are not posted yet.' });
        return;
      }
      // The real host asks for confirmation in a modal first; the harness takes it as confirmed.
      record('host (simulated)', { confirm: `Post ${effect.comments.length} comment(s) to ${target.kind === 'github' ? `${target.repo}#${target.number}` : '?'}` });
      m.setPostState({ target, status: 'posting' });
      sendReview();
      setTimeout(() => {
        if (options.postFails) m.setPostState({ target, status: 'error', error: 'gh: HTTP 422 Unprocessable Entity (simulated)' });
        else m.setPostState({ target, status: 'posted', url: target.kind === 'github' ? `${target.url}#pullrequestreview-1001` : undefined });
        sendReview();
      }, 900);
      return;
    }
    case 'export': {
      const md = reviewToMarkdown(m.snapshot(), m.graph, m.graph.pr.title);
      showExport(md);
      return;
    }
  }
}

const REVIEW_ACTIONS = new Set<ReviewAction['type']>([
  'setMode',
  'setDepth',
  'enter',
  'familiarity',
  'cancelGate',
  'answer',
  'selfCheck',
  'commentAction',
  'amend',
  'thread',
  'adoptProposal',
  'addNote',
  'draftWithAgent',
  'post',
  'exportReview',
]);

function onWebviewMessage(msg: WebviewToHost): void {
  record('webview → host', msg);
  if (REVIEW_ACTIONS.has(msg?.type as ReviewAction['type'])) {
    if (!model) return;
    const action = msg as ReviewAction;
    // The mode is global in the real host; the harness keeps it in its options.
    if (action.type === 'setMode') {
      options.mode = action.mode;
      saveOptions();
    }
    const effect = model.apply(action);
    sendReview();
    runEffect(effect);
    return;
  }
  switch (msg?.type) {
    case 'ready':
      void sendLoad({ agent: source === 'agent', pr: prLoaded });
      break;
    case 'select': {
      // The real host opens code only when the model allows it (not into fog), and the model
      // closes the gate on any allowed select.
      const ok = model?.select(msg.id) ?? true;
      if (!ok) record('host (simulated)', { refused: `select ${msg.id}: still in fog` });
      sendReview();
      break;
    }
    case 'stateChanged':
      hostView = msg.state;
      write(KEYS.view, hostView);
      break;
    case 'action':
      runSeq++;
      if (msg.action === 'useFixture') void sendLoad();
      else rerun(); // login, retry, rerun: the real host re-runs the agent
      break;
    default:
      break; // openAnchor / rendered: logged only (the real host opens code)
  }
}

window.acquireVsCodeApi = () => {
  if (acquired) throw new Error('An instance of the VS Code API has already been acquired');
  acquired = true;
  return Object.freeze({
    postMessage: (msg: unknown) => onWebviewMessage(structuredClone(msg) as WebviewToHost),
    getState: () => read(KEYS.webview),
    setState: (s: unknown) => {
      write(KEYS.webview, s);
      return s;
    },
  });
};

// ---- harness controls ------------------------------------------------------------------------------

function fillSelect(): void {
  const sel = document.getElementById('h-select-id') as HTMLSelectElement | null;
  if (!sel || !graph || sel.options.length) return;
  for (const n of graph.nodes) {
    const o = document.createElement('option');
    o.value = n.id;
    o.textContent = n.id;
    sel.append(o);
  }
  sel.value = 'money/roundToCents';
}

function setTheme(cls: string): void {
  document.body.classList.remove('vscode-light', 'vscode-dark', 'vscode-high-contrast');
  document.body.classList.add(cls);
  document.body.dataset.vscodeThemeKind = cls;
  for (const b of document.querySelectorAll<HTMLElement>('[data-theme]')) b.setAttribute('aria-pressed', String(b.dataset.theme === cls));
}

function setWidth(px: string): void {
  const frame = document.getElementById('harness-frame')!;
  if (px) {
    frame.dataset.width = px;
    frame.style.width = `${px}px`;
  } else {
    delete frame.dataset.width;
    frame.style.width = '';
  }
  for (const b of document.querySelectorAll<HTMLElement>('[data-width]')) b.setAttribute('aria-pressed', String(b.dataset.width === (px || '')));
}

function renderOptionState(): void {
  const pressed = (sel: string, on: boolean) => document.querySelector(sel)?.setAttribute('aria-pressed', String(on));
  const mode = model?.mode ?? options.mode;
  pressed('#h-mode-fast', mode === 'fast');
  pressed('#h-mode-didactic', mode === 'didactic');
  pressed('#h-agent', options.agent);
  pressed('#h-agent-fails', options.agentFails);
  pressed('#h-target', options.target === 'github');
  pressed('#h-post-fails', options.postFails);
  const qs = document.getElementById('h-questions') as HTMLSelectElement | null;
  if (qs) qs.value = options.questions;
}

function showExport(md: string): void {
  const box = document.getElementById('h-export') as HTMLDetailsElement | null;
  const pre = document.getElementById('h-export-text');
  if (!box || !pre) return;
  pre.textContent = md;
  box.hidden = false;
  box.open = true;
  record('host (simulated)', { exported: `${md.length} characters of Markdown (shown under the log)` });
}

function resetReview(): void {
  for (const k of [KEYS.review, KEYS.confidence]) {
    try {
      sessionStorage.removeItem(k);
    } catch {
      /* ignore */
    }
  }
  confidence = new MemoryConfidenceStore();
  if (graph) model = buildModel(graph);
  sendReview();
}

function wire(): void {
  const on = (id: string, fn: () => void) => document.getElementById(id)?.addEventListener('click', fn);
  for (const b of document.querySelectorAll<HTMLElement>('[data-theme]')) b.addEventListener('click', () => setTheme(b.dataset.theme!));
  for (const b of document.querySelectorAll<HTMLElement>('[data-width]')) b.addEventListener('click', () => setWidth(b.dataset.width ?? ''));
  // A manual send stops a simulated run, so its next frame doesn't overwrite what was clicked.
  const manual = (id: string, fn: () => void) =>
    on(id, () => {
      runSeq++;
      fn();
    });
  manual('h-load', () => void sendLoad());
  manual('h-load-warn', () => void sendLoad({ warnings: true }));
  manual('h-load-agent', () => void sendLoad({ agent: true }));
  manual('h-load-pr', () => void sendLoad({ pr: true }));
  on('h-pr-run', () => {
    lastRun = 'pr';
    void simulatePrRun();
  });
  on('h-pr-fail', () => {
    lastRun = 'pr';
    void simulatePrRun(6);
  });
  manual('h-loading', () => send({ type: 'loading', message: 'Asking claude to read the PR…', detail: 'Reading money/round.ts' }));
  manual('h-error', () =>
    send({
      type: 'error',
      message: 'The agent’s answer did not match the review-graph contract.',
      detail: '/nodes/3/risk must have required property "why"\n/edges/2/to "money/roundToCent" is not a node',
      actions: ['retry', 'useFixture', 'login'],
    }),
  );
  manual('h-error-auth', () => send({ type: 'error', message: 'Your claude session has expired.', detail: 'Run "claude auth login" in a terminal, then try again.', actions: ['login', 'useFixture'] }));
  on('h-select', () => send({ type: 'select', id: (document.getElementById('h-select-id') as HTMLSelectElement).value }));
  on('h-log-clear', () => {
    log.length = 0;
    document.getElementById('host-log')?.replaceChildren();
  });
  on('h-reset', () => {
    try {
      for (const k of Object.values(KEYS)) sessionStorage.removeItem(k);
    } catch {
      /* ignore */
    }
    location.reload();
  });

  // Review: the host-side switches a real host would get from settings, the agent and GitHub.
  const setMode = (mode: Mode) => {
    options.mode = mode;
    saveOptions();
    model?.setMode(mode);
    sendReview();
  };
  on('h-mode-fast', () => setMode('fast'));
  on('h-mode-didactic', () => setMode('didactic'));
  on('h-agent', () => {
    options.agent = !options.agent;
    saveOptions();
    model?.setAgentAvailable(options.agent);
    sendReview();
  });
  on('h-agent-fails', () => {
    options.agentFails = !options.agentFails;
    saveOptions();
  });
  on('h-target', () => {
    options.target = options.target === 'github' ? 'none' : 'github';
    saveOptions();
    model?.setPostState({ target: options.target === 'github' ? GITHUB_TARGET : SAMPLE_TARGET, status: 'idle' });
    sendReview();
  });
  on('h-post-fails', () => {
    options.postFails = !options.postFails;
    saveOptions();
  });
  document.getElementById('h-questions')?.addEventListener('change', (ev) => {
    options.questions = (ev.target as HTMLSelectElement).value as Options['questions'];
    saveOptions();
    const status = questionsStatus();
    model?.setQuestions(status.state === 'ready' ? questionSet : undefined, status);
    sendReview();
  });
  on('h-review-reset', resetReview);
  on('h-export-close', () => {
    const box = document.getElementById('h-export');
    if (box) box.hidden = true;
  });

  const params = new URLSearchParams(location.search);
  if (params.has('compact')) document.body.classList.add('harness-compact');
  const theme = params.get('theme');
  setTheme(theme ? `vscode-${theme}` : matchMedia('(prefers-color-scheme: dark)').matches ? 'vscode-dark' : 'vscode-light');
  const mode = params.get('mode');
  if (mode === 'fast' || mode === 'didactic') options.mode = mode;
  setWidth(params.get('width') ?? '');
  renderOptionState();
  void fixtures().catch(() => {});
}

window.__filosHarness = {
  send,
  sendLoad,
  simulatePrRun,
  setTheme,
  setWidth,
  sendReview,
  resetReview,
  get model() {
    return model;
  },
  get options() {
    return { ...options };
  },
};
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wire, { once: true });
else wire();

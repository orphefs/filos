// Question cards and the Questions tab. A card asks, takes the answer (a choice, or free text),
// and shows the feedback: a Socratic hint and another try, an explanation, the agent's reply, or
// a self-check against the reference. Verdicts are always words plus a symbol, never colour alone.
// Finished cards fold to one line; the one just answered stays open so its feedback can be read.

import type { Choice, Question } from '../contract/questions';
import { answerFor, type AnswerState, type Attempt } from '../review/types';
import { h } from './dom';
import { fogIcon } from './render';
import { agentName, answerable, commentFromQuestion, costNote, nodeLabel, nodeName, paneButton, spinnerLine, uid, writtenBy, type PaneContext } from './paneContext';

const SEVERITY_WORD = { blocking: 'blocking', suggestion: 'suggestion', question: 'question', nit: 'nit' } as const;

const isGate = (q: Question) => q.id.startsWith('gate:');

/** Words and symbol for an attempt's outcome. */
function verdictOf(q: Question, a: AnswerState, last: Attempt): { cls: string; mark: string; text: string } {
  switch (last.verdict) {
    case 'correct':
      return { cls: 'correct', mark: '✓', text: last.by === 'self' ? 'You got it' : 'Correct' };
    case 'partly':
      return { cls: 'partly', mark: '◐', text: 'Partly right' };
    case 'incorrect':
      if (!a.done) return { cls: 'retry', mark: '↻', text: 'Not quite. Think about this:' };
      return { cls: 'incorrect', mark: '✗', text: last.by === 'self' ? 'You missed something' : 'Not this time' };
    case 'noted':
    default:
      if (q.purpose === 'judge' && q.choices) return { cls: 'noted', mark: '●', text: 'Your call' };
      return { cls: 'noted', mark: '●', text: 'Noted' };
  }
}

/** One-word state for the folded line and the data-state attribute. */
function stateOf(a: AnswerState | undefined): 'new' | 'retry' | 'pending' | 'selfcheck' | 'done' {
  if (!a?.attempts.length) return 'new';
  if (a.pending) return 'pending';
  if (a.awaitingSelfCheck) return 'selfcheck';
  if (a.done) return 'done';
  return 'retry';
}

export interface CardOptions {
  /** Shown in the didactic gate: never folds, and no node chip (the gate names the territory). */
  atGate?: boolean;
}

export function questionCard(q: Question, ctx: PaneContext, opts: CardOptions = {}): HTMLElement {
  const a = answerFor(ctx.review.answers, q.id);
  const state = stateOf(a);
  const promptId = uid('qp');
  const card = h('article', {
    class: `qcard qcard--${state}${opts.atGate ? ' qcard--gate' : ''}`,
    'data-question-id': q.id,
    'data-state': state,
    'aria-labelledby': promptId,
  });
  const folded = state === 'done' && !opts.atGate && !ctx.ui.openCards.has(q.id);
  if (folded && a) {
    card.classList.add('is-folded');
    card.append(foldedRow(q, a, ctx, promptId));
    return card;
  }

  card.append(cardHead(q, ctx, opts, state === 'done'));
  card.append(h('p', { class: 'qcard-prompt', id: promptId }, q.prompt));

  const canAnswer = answerable(ctx, q);
  const fb = feedback(q, a, ctx);
  if (q.choices) {
    card.append(choiceList(q, q.choices, a, ctx, canAnswer));
    if (fb) card.append(fb);
  } else {
    // What they wrote, then the feedback on it, then (after a hint) the box for another try.
    const { history, input } = openArea(q, a, ctx, canAnswer);
    card.append(...history);
    if (fb) card.append(fb);
    card.append(...input);
  }
  if (!canAnswer && state !== 'done' && !opts.atGate) {
    card.append(h('p', { class: 'muted small locked-note' }, 'Explore this part of the map to answer.'));
  }
  return card;
}

function cardHead(q: Question, ctx: PaneContext, opts: CardOptions, done: boolean): HTMLElement {
  const tags = h('div', { class: 'qcard-tags' });
  const head = h('div', { class: 'qcard-head' }, tags);
  if (!opts.atGate) {
    const node = ctx.model.byId.get(q.nodeId);
    const chip = paneButton([nodeName(node, q.nodeId)], `q:${q.id}:node`, () => ctx.selectNode(q.nodeId), {
      class: 'node-chip',
      'aria-label': `Show ${nodeLabel(ctx, q.nodeId)} in the graph`,
    });
    tags.append(chip);
  }
  tags.append(
    h('span', { class: `qtag qtag--${q.stage}` }, q.stage === 'predict' ? 'Before you read' : 'After reading'),
    h('span', { class: `qtag qtag--${q.purpose}` }, q.purpose === 'understand' ? 'Understanding' : 'Your call'),
  );
  if (done && !opts.atGate) {
    head.append(
      paneButton('Fold', `q:${q.id}:toggle`, () => {
        ctx.ui.openCards.delete(q.id);
        ctx.rerender([`q:${q.id}:toggle`]);
      }, { class: 'link-button', 'aria-expanded': 'true', 'aria-label': 'Fold this question' }),
    );
  }
  return head;
}

function foldedRow(q: Question, a: AnswerState, ctx: PaneContext, promptId: string): HTMLElement {
  const last = a.attempts[a.attempts.length - 1];
  const v = verdictOf(q, a, last);
  const b = paneButton(
    [
      h('span', { class: `verdict-chip verdict--${v.cls}` }, h('span', { 'aria-hidden': 'true' }, v.mark), ` ${v.text}`),
      h('span', { class: 'qcard-oneline', id: promptId }, q.prompt),
    ],
    `q:${q.id}:toggle`,
    () => {
      ctx.ui.openCards.add(q.id);
      ctx.rerender([`q:${q.id}:toggle`]);
    },
    { class: 'qcard-fold', 'aria-expanded': 'false' },
  );
  return b;
}

function choiceList(q: Question, choices: Choice[], a: AnswerState | undefined, ctx: PaneContext, canAnswer: boolean): HTMLElement {
  const list = h('div', { class: 'choices', role: 'group', 'aria-label': 'Answers' });
  const attempts = a?.attempts ?? [];
  const last = attempts[attempts.length - 1];
  const tried = new Set(attempts.map((t) => t.choiceId).filter((id): id is string => !!id));
  const done = !!a?.done;
  const judge = q.purpose === 'judge';
  choices.forEach((c, i) => {
    const letter = String.fromCharCode(65 + (i % 26));
    const chosenNow = last?.choiceId === c.id;
    let mark: HTMLElement | null = null;
    if (judge && chosenNow) mark = h('span', { class: 'choice-mark mark--noted' }, '● Your call');
    else if (!judge && tried.has(c.id) && c.correct) mark = h('span', { class: 'choice-mark mark--correct' }, '✓ Right');
    else if (!judge && tried.has(c.id)) mark = h('span', { class: 'choice-mark mark--incorrect' }, done ? '✗ Not this one' : '✗ Tried');
    else if (!judge && done && c.correct) mark = h('span', { class: 'choice-mark mark--correct' }, '✓ Correct answer');
    // Graded answers are final; a judgement can be changed (its draft comment follows).
    const locked = !canAnswer || (!judge && (done || tried.has(c.id))) || !!a?.pending;
    const b = paneButton(
      [h('span', { class: 'choice-key', 'aria-hidden': 'true' }, letter), h('span', { class: 'choice-text' }, c.text), mark],
      `q:${q.id}:choice:${c.id}`,
      () => {
        ctx.ui.openCards.add(q.id);
        ctx.act({ type: 'answer', questionId: q.id, choiceId: c.id }, ['gate:continue', `q:${q.id}:feedback`]);
      },
      {
        class: `choice${chosenNow ? ' is-chosen' : ''}${tried.has(c.id) ? ' is-tried' : ''}`,
        'aria-pressed': chosenNow ? 'true' : 'false',
        'aria-disabled': locked ? 'true' : undefined,
        'aria-label': `${letter}: ${c.text}${mark ? `. ${mark.textContent}` : ''}`,
        'data-choice-id': c.id,
      },
    );
    list.append(b);
  });
  return list;
}

function openArea(q: Question, a: AnswerState | undefined, ctx: PaneContext, canAnswer: boolean): { history: Node[]; input: Node[] } {
  const history: Node[] = [];
  const out: Node[] = [];
  const attempts = a?.attempts ?? [];
  // What they wrote so far, newest last.
  attempts.forEach((t, i) => {
    if (!t.text) return;
    const label = attempts.length > 1 ? (i === attempts.length - 1 ? 'Your second try' : 'Your first try') : 'You wrote';
    history.push(h('div', { class: 'your-answer' }, h('p', { class: 'mini-label' }, label), h('blockquote', {}, t.text)));
  });

  if (a?.pending) {
    // Focus waits here (where the feedback will appear) while the agent grades.
    const line = spinnerLine(`${agentName(ctx.review, true)} is reading your answer…`);
    line.tabIndex = -1;
    line.dataset.focusKey = `q:${q.id}:feedback`;
    out.push(line);
    return { history, input: out };
  }
  if (a?.awaitingSelfCheck) {
    const last = attempts[attempts.length - 1];
    out.push(
      h(
        'div',
        // Focus lands here after answering, so the reference is read next.
        { class: 'selfcheck', tabindex: -1, 'data-focus-key': `q:${q.id}:feedback` },
        h('p', { class: 'mini-label' }, 'A good answer covers'),
        h('blockquote', { class: 'reference' }, last?.reply || q.reference || ''),
        h('p', { class: 'selfcheck-ask' }, 'Compare it with yours. Did you get it?'),
        h(
          'div',
          { class: 'button-row' },
          paneButton('I got it', `q:${q.id}:gotit`, () => ctx.act({ type: 'selfCheck', questionId: q.id, gotIt: true }, ['gate:continue', `q:${q.id}:feedback`]), { class: 'primary' }),
          paneButton('I missed something', `q:${q.id}:missed`, () => ctx.act({ type: 'selfCheck', questionId: q.id, gotIt: false }, ['gate:continue', `q:${q.id}:feedback`])),
        ),
      ),
    );
    return { history, input: out };
  }
  if (a?.done || !canAnswer) return { history, input: out };

  // New, or a first wrong attempt the agent answered with a hint: (another) answer box.
  const key = `answer:${q.id}`;
  const again = attempts.length > 0;
  const agentGrades = ctx.review.agentAvailable && q.purpose === 'understand' && !isGate(q);
  const noteId = uid('cost');
  const submit = paneButton(again ? 'Answer again' : 'Answer', `q:${q.id}:submit`, () => {
    const text = ctx.drafts.get(key).trim();
    if (!text) {
      ta.focus();
      ctx.announce('Write an answer first.');
      return;
    }
    const before = attempts.length;
    ctx.drafts.clearOnceArrived(key, (review) => (answerFor(review.answers, q.id)?.attempts.length ?? 0) > before);
    ctx.ui.openCards.add(q.id);
    ctx.act({ type: 'answer', questionId: q.id, text }, ['gate:continue', `q:${q.id}:feedback`]);
  }, { class: 'primary', 'aria-describedby': agentGrades ? noteId : undefined });
  const ta = ctx.drafts.textarea(key, {
    class: 'answer-input',
    rows: 3,
    'aria-label': again ? 'Your answer, second try' : 'Your answer',
    placeholder: isGate(q) ? 'A sentence or two is plenty.' : 'Your answer, in your own words',
  });
  // Ctrl/Cmd+Enter submits, as in most review tools.
  ta.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter' && (ev.ctrlKey || ev.metaKey)) {
      ev.preventDefault();
      submit.click();
    }
  });
  out.push(h('div', { class: 'answer-box' }, ta, h('div', { class: 'button-row' }, submit, agentGrades ? costNote(noteId, ctx.review) : null)));
  return { history, input: out };
}

function feedback(q: Question, a: AnswerState | undefined, ctx: PaneContext): HTMLElement | null {
  const last = a?.attempts[a.attempts.length - 1];
  if (!a || !last || a.pending || a.awaitingSelfCheck) return null;
  const v = verdictOf(q, a, last);
  // Open answers graded "noted" with nothing to say need no feedback box beyond the mark.
  const box = h('div', { class: `feedback verdict--${v.cls}`, tabindex: -1, 'data-focus-key': `q:${q.id}:feedback` });
  box.append(h('p', { class: 'verdict-line' }, h('span', { class: 'verdict-mark', 'aria-hidden': 'true' }, v.mark), h('strong', {}, v.text)));
  if (last.reply) box.append(h('p', { class: 'reply' }, last.reply));
  if (last.by === 'agent') box.append(h('p', { class: 'reply-by' }, `Feedback from ${writtenBy(last.agentName)}`));

  if (v.cls === 'retry') {
    const again = paneButton('Try again', `q:${q.id}:again`, () => {
      // Focus the way back in: the first choice not tried yet, or the answer box.
      const tried = new Set(a.attempts.map((t) => t.choiceId));
      const next = q.choices?.find((c) => !tried.has(c.id));
      const key = next ? `q:${q.id}:choice:${next.id}` : `answer:${q.id}`;
      ctx.rerender([key]);
    });
    box.append(h('div', { class: 'button-row' }, again));
  }

  const drafted = commentFromQuestion(ctx.review, q.id);
  if (drafted && a.done) {
    box.append(
      h(
        'p',
        { class: 'drafted-note' },
        `This drafted a ${SEVERITY_WORD[drafted.severity] ?? 'review'} comment. `,
        paneButton('See it in Comments', `q:${q.id}:comment`, () => ctx.showComment(drafted.id), { class: 'link-button' }),
      ),
    );
  }
  return box;
}

/** The Questions tab: the selected node's questions (or all), grouped by territory. */
export function questionsPanel(ctx: PaneContext): Node[] {
  const { review } = ctx;
  const out: Node[] = [];
  const all = review.questions;
  const done = all.filter((q) => answerFor(review.answers, q.id)?.done).length;

  out.push(
    h(
      'div',
      { class: 'pane-head' },
      h('h2', { class: 'pane-title' }, 'Questions'),
      h('p', { class: 'pane-sub' }, all.length ? `${done} of ${all.length} answered · ${depthWord(review.depth.chosen)} depth` : `${depthWord(review.depth.chosen)} depth`),
    ),
  );

  const status = review.questionsStatus;
  if (status.state === 'loading') out.push(spinnerLine(`${agentName(review, true)} is writing questions about this PR…`));
  else if (status.state === 'error') out.push(h('p', { class: 'notice notice--error', role: 'status' }, status.message || 'The questions could not be written.'));
  else if (status.state === 'none' && !all.length) out.push(h('p', { class: 'notice' }, status.message || 'No questions for this review.'));

  const sel = ctx.selected;
  const selNode = sel ? ctx.model.byId.get(sel) : undefined;
  let shown = all;
  if (selNode && !ctx.ui.showAll) {
    const inside = new Set([selNode.id, ...ctx.index.descendants(selNode.id).map((n) => n.id)]);
    const territory = ctx.index.isTerritory(selNode.id);
    shown = all.filter((q) => inside.has(q.nodeId) || (territory && ctx.index.groupOf(q.nodeId) === selNode.id));
  }
  if (selNode) {
    const toggle = paneButton(ctx.ui.showAll ? `Show only ${selNode.label}` : `Show all questions (${all.length})`, 'questions:showAll', () => {
      ctx.ui.showAll = !ctx.ui.showAll;
      ctx.rerender(['questions:showAll']);
    }, { class: 'link-button', 'aria-pressed': ctx.ui.showAll ? 'true' : 'false' });
    out.push(
      h(
        'div',
        { class: 'filter-row' },
        h('span', {}, ctx.ui.showAll ? 'All questions' : `About ${selNode.label}${selNode.kind === 'module' ? ' and what is inside' : ''}: ${shown.length}`),
        toggle,
      ),
    );
    if (!shown.length && all.length) out.push(h('p', { class: 'muted small' }, `No questions about ${selNode.label} at this depth.`));
  }

  // Grouped by territory, in asking order (the snapshot's order: riskiest territory first).
  const groups = new Map<string, Question[]>();
  for (const q of shown) {
    const g = ctx.index.groupOf(q.nodeId);
    const list = groups.get(g) ?? [];
    list.push(q);
    groups.set(g, list);
  }
  const filtered = !!selNode && !ctx.ui.showAll;
  for (const [g, qs] of groups) {
    const doneHere = qs.filter((q) => answerFor(review.answers, q.id)?.done).length;
    const fogged = ctx.fog.fogged.has(g);
    const headId = uid('qg');
    const sec = h('section', { class: `qgroup${fogged ? ' is-fogged' : ''}`, 'aria-labelledby': headId, 'data-group': g });
    // Filtered to one node, the filter line already says what these are about.
    if (filtered && !fogged) {
      sec.removeAttribute('aria-labelledby');
      for (const q of qs) sec.append(questionCard(q, ctx));
      out.push(sec);
      continue;
    }
    sec.append(
      h(
        'h3',
        { class: 'qgroup-title', id: headId },
        nodeName(ctx.model.byId.get(g), g),
        h('span', { class: 'qgroup-count' }, fogged ? `${qs.length} question${qs.length === 1 ? '' : 's'}` : `${doneHere} of ${qs.length} answered`),
      ),
    );
    if (fogged) {
      // Didactic: questions in fog wait behind the gate. Entering asks the territory's first one.
      sec.append(
        h(
          'p',
          { class: 'fog-note' },
          fogIcon(),
          ` Unexplored. Enter ${nodeLabel(ctx, g)} on the map to answer these.`,
        ),
        paneButton(`Enter ${nodeLabel(ctx, g)}`, `group:${g}:enter`, () => ctx.enter(g), { class: 'secondary' }),
      );
    } else {
      for (const q of qs) sec.append(questionCard(q, ctx));
    }
    out.push(sec);
  }
  if (!all.length && status.state === 'ready') out.push(h('p', { class: 'muted' }, 'No questions at this depth. Try a deeper one from the Depth menu.'));
  return out;
}

export function depthWord(d: string): string {
  return d === 'skim' ? 'Skim' : d === 'deep' ? 'Deep' : 'Standard';
}

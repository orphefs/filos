// The side pane beside the graph: tabs for Summary | Questions | Comments, and in didactic mode the
// gate into a territory, which takes the pane over until the reviewer enters or says "Not now".
// Rebuilt from every review snapshot; drafts, focus and scroll survive the rebuild (drafts.ts).

import type { ReviewAction } from '../protocol';
import type { GraphIndex } from '../review/order';
import { answerFor, type Familiarity, type ReviewSnapshot } from '../review/types';
import { commentsPanel } from './comments';
import { h } from './dom';
import { captureFocus, Drafts, restoreFocus } from './drafts';
import type { Fog } from './fog';
import type { Model } from './model';
import { nodeLabel, paneButton, spinnerLine, type PaneContext, type PaneTab, type PaneUi } from './paneContext';
import { questionCard, questionsPanel } from './questions';

export interface PaneHost {
  model(): Model | undefined;
  index(): GraphIndex | undefined;
  fog(): Fog;
  selected(): string | undefined;
  post(action: ReviewAction): void;
  /** Select a node from the pane: reveal it in the graph and open its code. */
  selectNode(id: string): void;
  enter(id: string): void;
  /** After the gate: open the territory in the graph and select it. */
  continueInto(id: string): void;
  /** Give keyboard focus back to a node in the graph. */
  focusNode(id: string): void;
  announce(text: string): void;
  tabChanged(tab: PaneTab): void;
}

const TABS: { id: PaneTab; label: string }[] = [
  { id: 'summary', label: 'Summary' },
  { id: 'questions', label: 'Questions' },
  { id: 'comments', label: 'Comments' },
];

const FAMILIARITY: { level: Familiarity; label: string }[] = [
  { level: 'new', label: 'New to me' },
  { level: 'some', label: 'Somewhat' },
  { level: 'known', label: 'I know it well' },
];

export class ReviewPane {
  readonly el: HTMLElement;
  private readonly tablist: HTMLElement;
  private readonly tabBtns = new Map<PaneTab, HTMLButtonElement>();
  private readonly panels = new Map<PaneTab, HTMLElement>();
  private readonly gateEl: HTMLElement;
  private readonly drafts = new Drafts();
  private readonly ui: PaneUi;
  private review?: ReviewSnapshot;

  constructor(
    summaryScroll: HTMLElement,
    private readonly host: PaneHost,
    initialTab: PaneTab,
  ) {
    this.ui = { tab: initialTab, openCards: new Set(), openThreads: new Set(), amending: new Set(), showAll: false, postedIds: new Set() };
    this.tablist = h('div', { class: 'pane-tabs', role: 'tablist', 'aria-label': 'Side pane', hidden: true });
    for (const t of TABS) {
      const b = h('button', { type: 'button', class: 'pane-tab', role: 'tab', id: `filos-tab-${t.id}`, 'aria-controls': `filos-panel-${t.id}`, 'data-tab': t.id });
      b.addEventListener('click', () => this.showTab(t.id));
      this.tabBtns.set(t.id, b);
      this.tablist.append(b);
    }
    this.tablist.addEventListener('keydown', (ev) => this.onTabKey(ev));

    // Summary keeps its own scroller (the existing summary pane); the others scroll in their panel.
    const summaryPanel = h('div', { class: 'pane-panel pane-panel--summary', role: 'tabpanel', id: 'filos-panel-summary', 'aria-labelledby': 'filos-tab-summary' }, summaryScroll);
    this.panels.set('summary', summaryPanel);
    for (const t of ['questions', 'comments'] as const) {
      this.panels.set(t, h('div', { class: `pane-panel pane-scroll pane-panel--${t}`, role: 'tabpanel', id: `filos-panel-${t}`, 'aria-labelledby': `filos-tab-${t}`, tabindex: 0, 'data-scroll-key': t, hidden: true }));
    }
    this.gateEl = h('section', { class: 'gate pane-scroll', hidden: true, 'data-scroll-key': 'gate', 'aria-label': 'Entering a territory' });
    // Escape leaves the gate, like "Not now" (but not while typing an answer).
    this.gateEl.addEventListener('keydown', (ev) => {
      if (ev.key !== 'Escape' || (ev.target as HTMLElement).closest('textarea') || !this.review?.gate) return;
      ev.preventDefault();
      this.host.post({ type: 'cancelGate' });
    });
    this.el = h('div', { class: 'side-pane' }, this.gateEl, this.tablist, ...this.panels.values());
    this.applyTab();
  }

  get tab(): PaneTab {
    return this.ui.tab;
  }

  /** A new snapshot (or none: an old host, or no review yet). */
  update(review: ReviewSnapshot | undefined): void {
    const prev = this.review;
    this.review = review;
    if (review) this.drafts.settle(review);
    if (review?.post.status === 'posted' && prev?.post.status !== 'posted' && this.ui.postingIds) {
      for (const id of this.ui.postingIds) this.ui.postedIds.add(id);
    }
    if (review && prev) this.announceChanges(prev, review);
    // The gate just opened: put focus on its heading so the question is read next.
    const gateOpened = !!review?.gate && review.gate.nodeId !== prev?.gate?.nodeId;
    const gateClosed = !review?.gate && !!prev?.gate;
    const focusWasInGate = this.gateEl.contains(document.activeElement);
    this.render(gateOpened ? ['gate:title'] : this.pendingFocus);
    this.pendingFocus = undefined;
    if (gateClosed && focusWasInGate && !this.el.contains(document.activeElement)) this.host.focusNode(prev!.gate!.nodeId);
  }

  /** Focus requested by the last action, applied after the snapshot it causes. */
  private pendingFocus?: string[];

  /** The selection changed (filters the Questions tab, attaches notes). */
  selectionChanged(): void {
    if (this.review && this.ui.tab !== 'summary') this.render();
  }

  showTab(tab: PaneTab, focusTab = false): void {
    if (this.ui.tab !== tab) {
      this.ui.tab = tab;
      this.host.tabChanged(tab);
    }
    this.applyTab();
    this.render();
    if (focusTab) this.tabBtns.get(tab)?.focus();
  }

  /** Comments tab, scrolled to and focused on one comment. */
  showComment(id: string): void {
    this.ui.tab = 'comments';
    this.host.tabChanged('comments');
    this.applyTab();
    this.render([`c:${id}`]);
    const card = this.el.querySelector<HTMLElement>(`[data-comment-id="${CSS.escape(id)}"]`);
    card?.scrollIntoView({ block: 'nearest' });
  }

  render(focusNext?: string[]): void {
    const review = this.review;
    const model = this.host.model();
    const index = this.host.index();
    const memo = captureFocus(this.el);
    this.tablist.hidden = !review;
    if (!review || !model || !index) {
      // No review state (yet): the summary alone, without forgetting which tab was chosen.
      this.gateEl.hidden = true;
      for (const [t, p] of this.panels) p.hidden = t !== 'summary';
      return;
    }
    const ctx = this.context(review, model, index);
    this.renderTabs(review);
    this.applyTab();

    const gate = review.gate;
    this.gateEl.hidden = !gate;
    this.tablist.hidden = !!gate;
    for (const [t, p] of this.panels) p.hidden = !!gate || t !== this.ui.tab;
    if (gate) {
      this.gateEl.replaceChildren(...this.gateView(ctx));
    } else {
      this.gateEl.replaceChildren();
      if (this.ui.tab === 'questions') this.panels.get('questions')!.replaceChildren(...questionsPanel(ctx));
      if (this.ui.tab === 'comments') this.panels.get('comments')!.replaceChildren(...commentsPanel(ctx));
    }
    let prefer: string | undefined;
    for (const key of focusNext ?? []) {
      if (this.el.querySelector(`[data-focus-key="${CSS.escape(key)}"]`)) {
        prefer = key;
        break;
      }
    }
    restoreFocus(this.el, memo, prefer);
    if (prefer) document.activeElement?.scrollIntoView?.({ block: 'nearest' });
  }

  private context(review: ReviewSnapshot, model: Model, index: GraphIndex): PaneContext {
    return {
      review,
      model,
      index,
      fog: this.host.fog(),
      drafts: this.drafts,
      ui: this.ui,
      selected: this.host.selected(),
      act: (action, focusNext) => {
        this.pendingFocus = focusNext;
        this.host.post(action);
      },
      rerender: (focusNext) => this.render(focusNext),
      selectNode: (id) => this.host.selectNode(id),
      enter: (id) => this.host.enter(id),
      showComment: (id) => this.showComment(id),
      announce: (text) => this.host.announce(text),
    };
  }

  private renderTabs(review: ReviewSnapshot): void {
    const qs = review.questions;
    const done = qs.filter((q) => answerFor(review.answers, q.id)?.done).length;
    const toDecide = review.comments.filter((c) => c.status === 'draft').length;
    const accepted = review.comments.filter((c) => c.status === 'accepted').length;
    const loading = review.questionsStatus.state === 'loading';
    const set = (tab: PaneTab, label: string, count: string | undefined, name: string) => {
      const b = this.tabBtns.get(tab)!;
      b.replaceChildren(label, count ? h('span', { class: 'tab-count', 'aria-hidden': 'true' }, count) : '');
      b.setAttribute('aria-label', name);
    };
    set('summary', 'Summary', undefined, 'Summary');
    set('questions', 'Questions', loading ? '…' : qs.length ? `${done}/${qs.length}` : undefined, loading ? 'Questions, being written' : `Questions, ${done} of ${qs.length} answered`);
    set('comments', 'Comments', toDecide ? String(toDecide) : undefined, `Comments, ${toDecide} to decide, ${accepted} accepted`);
  }

  private applyTab(): void {
    for (const [t, b] of this.tabBtns) {
      const on = t === this.ui.tab;
      b.setAttribute('aria-selected', String(on));
      b.tabIndex = on ? 0 : -1;
    }
    for (const [t, p] of this.panels) p.hidden = t !== this.ui.tab || !!this.review?.gate;
  }

  private onTabKey(ev: KeyboardEvent): void {
    const order = TABS.map((t) => t.id);
    const i = order.indexOf(this.ui.tab);
    let next: PaneTab | undefined;
    if (ev.key === 'ArrowRight') next = order[(i + 1) % order.length];
    else if (ev.key === 'ArrowLeft') next = order[(i - 1 + order.length) % order.length];
    else if (ev.key === 'Home') next = order[0];
    else if (ev.key === 'End') next = order[order.length - 1];
    if (!next) return;
    ev.preventDefault();
    this.showTab(next, true);
  }

  // ---- the gate ------------------------------------------------------------------------------

  private gateView(ctx: PaneContext): Node[] {
    const gate = ctx.review.gate!;
    const label = nodeLabel(ctx, gate.nodeId);
    const territory = ctx.review.territories.find((t) => t.nodeId === gate.nodeId);
    const out: Node[] = [];
    out.push(
      h(
        'div',
        { class: 'gate-head' },
        h('p', { class: 'eyebrow' }, 'Entering a territory'),
        h('h2', { class: 'gate-title', tabindex: -1, 'data-focus-key': 'gate:title' }, label),
        h('p', { class: 'gate-lead' }, 'Asks before telling: the code opens once you’ve made a prediction.'),
      ),
    );

    if (gate.step === 'familiarity') {
      const qid = 'gate-fam-q';
      out.push(
        h(
          'div',
          { class: 'gate-step' },
          h('p', { class: 'gate-ask', id: qid }, `Have you worked with ${label} before?`),
          h(
            'div',
            { class: 'button-row familiarity', role: 'group', 'aria-labelledby': qid },
            ...FAMILIARITY.map((f) =>
              paneButton(f.label, `gate:fam:${f.level}`, () => ctx.act({ type: 'familiarity', nodeId: gate.nodeId, level: f.level }, ['gate:ask', 'gate:title']), {
                class: 'secondary',
                'data-familiarity': f.level,
              }),
            ),
          ),
          h('p', { class: 'private-note' }, h('strong', {}, 'Private.'), ' Kept on this machine only. It sets where your confidence in this module starts.'),
        ),
      );
    } else if (!gate.questionId) {
      out.push(spinnerLine('Claude Code is still writing the questions. The gate opens with the first one.'));
    } else {
      const q = ctx.review.questions.find((x) => x.id === gate.questionId);
      if (q) out.push(h('div', { class: 'gate-step' }, h('p', { class: 'gate-ask', tabindex: -1, 'data-focus-key': 'gate:ask' }, 'Before you read the code:'), questionCard(q, ctx, { atGate: true })));
    }

    if (territory?.explored) {
      out.push(
        h(
          'div',
          { class: 'gate-continue', role: 'status' },
          h('p', {}, h('strong', {}, `✓ Explored ${label}.`), ' Its code and the rest of its questions are open now.'),
          paneButton(`Continue into ${label}`, 'gate:continue', () => {
            // Inside, its questions come next: show them for the territory just entered.
            this.ui.showAll = false;
            if (this.ui.tab !== 'questions') {
              this.ui.tab = 'questions';
              this.host.tabChanged('questions');
            }
            this.host.continueInto(gate.nodeId);
          }, { class: 'primary' }),
        ),
      );
    }
    out.push(
      h(
        'div',
        { class: 'gate-foot' },
        paneButton(territory?.explored ? 'Back to the map' : 'Not now', 'gate:cancel', () => ctx.act({ type: 'cancelGate' }), { class: 'link-button' }),
      ),
    );
    return out;
  }

  // ---- announcements -------------------------------------------------------------------------

  private announceChanges(prev: ReviewSnapshot, next: ReviewSnapshot): void {
    const said: string[] = [];
    for (const [id, a] of Object.entries(next.answers)) {
      const before = answerFor(prev.answers, id);
      const last = a.attempts[a.attempts.length - 1];
      if (!last || a.pending) continue;
      const lastBefore = before?.attempts[before.attempts.length - 1];
      // A changed judgement replaces its attempt: same count, a different one.
      const replaced = !!lastBefore && (lastBefore.at !== last.at || lastBefore.choiceId !== last.choiceId);
      const changed = !before || before.attempts.length !== a.attempts.length || replaced || before.pending || (before.awaitingSelfCheck && !a.awaitingSelfCheck);
      if (!changed) continue;
      if (a.awaitingSelfCheck) said.push('Compare your answer with the reference.');
      else if (last.verdict === 'correct') said.push('Correct.');
      else if (last.verdict === 'partly') said.push('Partly right.');
      else if (last.verdict === 'incorrect') said.push(a.done ? 'Not this time. The explanation is shown.' : 'Not quite. A hint is shown; try again.');
      else said.push('Noted.');
    }
    if (next.comments.length > prev.comments.length) said.push(next.comments.length - prev.comments.length === 1 ? 'A comment was drafted.' : `${next.comments.length - prev.comments.length} comments were drafted.`);
    for (const c of next.comments) {
      const before = prev.comments.find((x) => x.id === c.id);
      if (before?.threadPending && !c.threadPending) said.push('Claude Code replied in the discussion.');
    }
    const explored = next.territories.filter((t) => t.explored && !prev.territories.find((p) => p.nodeId === t.nodeId)?.explored);
    for (const t of explored) said.push(`Explored ${nodeLabel({ model: this.host.model()! }, t.nodeId)}.`);
    if (next.post.status !== prev.post.status && next.post.status === 'posted') said.push('Posted the review.');
    if (said.length) this.host.announce(said.join(' '));
  }
}

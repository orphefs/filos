// Review controls in the header: Fast | Didactic mode, the review depth (the agent's proposal, which
// the reviewer can override), and in didactic mode the coverage meter. Progress is coverage of the
// map, never points.

import { DEPTHS, type Depth } from '../contract/questions';
import type { Mode, ReviewSnapshot } from '../review/types';
import { h } from './dom';
import { depthWord } from './questions';

export interface ControlsHandlers {
  setMode(mode: Mode): void;
  setDepth(depth: Depth): void;
}

const DEPTH_HELP: Record<Depth, string> = {
  skim: 'The riskiest changes and the predictions that open each module.',
  standard: 'Every changed symbol and the design calls in it.',
  deep: 'Also the context code, outside consumers, tests and edge cases.',
};

const MODE_HELP: Record<Mode, string> = {
  fast: 'Graph, questions and comments: get through the PR quickly.',
  didactic: 'Asks before telling: answer a question to enter each part of the map.',
};

export class ReviewControls {
  readonly el: HTMLElement;
  private readonly modeBtns: Record<Mode, HTMLButtonElement>;
  private readonly depthBtn: HTMLButtonElement;
  private readonly depthMenu: HTMLElement;
  private readonly coverage: HTMLElement;
  private review?: ReviewSnapshot;
  private menuOpen = false;

  constructor(private readonly handlers: ControlsHandlers) {
    const modeBtn = (mode: Mode, label: string) => {
      const b = h('button', { type: 'button', class: 'seg', 'aria-pressed': 'false', 'data-mode': mode, title: MODE_HELP[mode] }, label);
      b.addEventListener('click', () => {
        if (this.review?.mode !== mode) this.handlers.setMode(mode);
      });
      return b;
    };
    this.modeBtns = { fast: modeBtn('fast', 'Fast'), didactic: modeBtn('didactic', 'Didactic') };
    const modeGroup = h('div', { class: 'mode-switch', role: 'group', 'aria-label': 'Review mode' }, this.modeBtns.fast, this.modeBtns.didactic);

    this.depthBtn = h('button', { type: 'button', class: 'depth-button', 'aria-haspopup': 'dialog', 'aria-expanded': 'false', 'aria-controls': 'filos-depth-menu' });
    this.depthBtn.addEventListener('click', () => this.toggleMenu(!this.menuOpen));
    this.depthMenu = h('div', { class: 'depth-menu', id: 'filos-depth-menu', role: 'dialog', 'aria-label': 'Review depth', hidden: true });
    this.depthMenu.addEventListener('keydown', (ev) => {
      if (ev.key === 'Escape') {
        ev.preventDefault();
        ev.stopPropagation();
        this.toggleMenu(false, true);
      }
    });
    // Clicking anywhere else closes the menu.
    document.addEventListener('pointerdown', (ev) => {
      if (this.menuOpen && !this.depthMenu.contains(ev.target as Node) && !this.depthBtn.contains(ev.target as Node)) this.toggleMenu(false);
    });
    const depthWrap = h('div', { class: 'depth-wrap' }, this.depthBtn, this.depthMenu);

    this.coverage = h('div', { class: 'coverage', hidden: true });
    this.el = h('div', { class: 'review-controls', hidden: true }, modeGroup, depthWrap, this.coverage);
  }

  update(review: ReviewSnapshot | undefined): void {
    this.review = review;
    this.el.hidden = !review;
    if (!review) return;
    for (const m of ['fast', 'didactic'] as const) this.modeBtns[m].setAttribute('aria-pressed', String(review.mode === m));

    const { chosen, proposed } = review.depth;
    this.depthBtn.replaceChildren(
      h('span', { class: 'depth-label' }, 'Depth: '),
      h('strong', {}, depthWord(chosen)),
      h('span', { class: 'depth-note' }, chosen === proposed ? ' · proposed' : ` · proposed: ${depthWord(proposed)}`),
      h('span', { class: 'caret', 'aria-hidden': 'true' }, '▾'),
    );
    if (this.menuOpen) this.fillMenu(this.depthMenu.contains(document.activeElement));

    const { explored, total } = review.coverage;
    this.coverage.hidden = review.mode !== 'didactic' || !total;
    if (!this.coverage.hidden) {
      const text = `Explored ${explored} of ${total} ${total === 1 ? 'territory' : 'territories'}`;
      const bar = h('progress', { class: 'coverage-bar', max: total, value: explored, 'aria-label': text });
      this.coverage.replaceChildren(h('span', { class: 'coverage-text' }, text), bar);
    }
  }

  /** Question counts per depth: from the host when it sends them, else from the questions in hand. */
  private counts(review: ReviewSnapshot): Partial<Record<Depth, number>> {
    const sent = (review.depth as { counts?: Partial<Record<Depth, number>> }).counts;
    if (sent) return sent;
    // The snapshot holds the chosen depth's questions only: shallower depths can be counted, deeper can't.
    const real = review.questions.filter((q) => !q.id.startsWith('gate:'));
    const out: Partial<Record<Depth, number>> = {};
    const upTo = DEPTHS.indexOf(review.depth.chosen);
    DEPTHS.forEach((d, i) => {
      if (i <= upTo) out[d] = real.filter((q) => DEPTHS.indexOf(q.depth) <= i).length;
    });
    return out;
  }

  private fillMenu(focus: boolean): void {
    const review = this.review;
    if (!review) return;
    const counts = this.counts(review);
    const name = 'filos-depth';
    const fieldset = h('fieldset', { class: 'depth-options' }, h('legend', {}, 'How deep should this review go?'));
    for (const d of DEPTHS) {
      const id = `filos-depth-${d}`;
      const input = h('input', { type: 'radio', name, id, value: d, checked: review.depth.chosen === d });
      input.addEventListener('change', () => {
        if (input.checked) this.handlers.setDepth(d);
      });
      const n = counts[d];
      fieldset.append(
        h(
          'label',
          { class: `depth-option${review.depth.chosen === d ? ' is-chosen' : ''}`, for: id },
          input,
          h(
            'span',
            { class: 'depth-option-text' },
            h('span', { class: 'depth-option-name' }, depthWord(d), review.depth.proposed === d ? h('span', { class: 'proposed-tag' }, 'proposed') : null),
            h('span', { class: 'depth-option-count' }, n === undefined ? 'more questions' : `${n} question${n === 1 ? '' : 's'}`),
            h('span', { class: 'depth-option-help' }, DEPTH_HELP[d]),
          ),
        ),
      );
    }
    const done = h('button', { type: 'button', class: 'secondary' }, 'Done');
    done.addEventListener('click', () => this.toggleMenu(false, true));
    this.depthMenu.replaceChildren(fieldset);
    if (review.depth.why) this.depthMenu.append(h('p', { class: 'depth-why' }, h('strong', {}, `Why ${depthWord(review.depth.proposed).toLowerCase()}: `), review.depth.why));
    this.depthMenu.append(h('div', { class: 'button-row' }, done));
    if (focus) this.depthMenu.querySelector<HTMLInputElement>('input:checked')?.focus();
  }

  private toggleMenu(open: boolean, returnFocus = false): void {
    this.menuOpen = open;
    this.depthBtn.setAttribute('aria-expanded', String(open));
    this.depthMenu.hidden = !open;
    if (open) this.fillMenu(true);
    else if (returnFocus) this.depthBtn.focus();
  }
}

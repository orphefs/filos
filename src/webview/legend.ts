// "How to read the graph": every colour, shape and line style used in the graph, drawn with the
// same CSS classes as the graph itself so it always matches the theme.

import { h, s } from './dom';
import { setTint } from './render';

function swatch(width: number, height: number, ...children: SVGElement[]): SVGSVGElement {
  return s('svg', { class: 'legend-swatch', width, height, viewBox: `0 0 ${width} ${height}`, 'aria-hidden': 'true' }, ...children);
}

function tinted(level: number, extraClass = ''): SVGRectElement {
  const r = s('rect', { class: `legend-node ${extraClass}`, x: 1, y: 1, width: 30, height: 18, rx: 4 });
  setTint(r, level);
  return r;
}

function edgeSwatch(kind: string, count?: number): SVGSVGElement {
  const g = s(
    'g',
    { class: `edge edge--${kind}${count ? ' edge--merged' : ''}` },
    s('path', { class: 'edge-line', d: 'M2 10 H34' }),
    s('path', { class: 'edge-arrow', d: 'M42 10 L33 5.5 L33 14.5 Z' }),
  );
  if (count) {
    g.style.setProperty('--edge-w', '3px');
    g.append(s('g', { class: 'edge-count', transform: 'translate(20,10)' }, s('circle', { r: 8 }), s('text', { y: 3.5, 'text-anchor': 'middle' }, String(count))));
  }
  return swatch(44, 20, g);
}

function row(sw: Element, term: string, desc: string): HTMLElement {
  return h('div', { class: 'legend-row' }, h('dt', {}, sw, h('span', {}, term)), h('dd', {}, desc));
}

export function buildLegend(): HTMLElement {
  const scale = h('div', { class: 'legend-scale', 'aria-hidden': 'true' });
  for (const level of [0, 0.17, 0.33, 0.5, 0.67, 0.83, 1]) scale.append(swatch(32, 20, tinted(level)));

  return h(
    'div',
    { class: 'legend' },
    h('h4', {}, 'Colour: risk'),
    h(
      'div',
      { class: 'legend-risk' },
      scale,
      h('div', { class: 'legend-scale-labels', 'aria-hidden': 'true' }, h('span', {}, 'low'), h('span', {}, 'medium'), h('span', {}, 'high')),
      h(
        'p',
        { class: 'legend-note' },
        'Redder means riskier. The score adds up countable signals: consumers outside this repo (weighted most), public API, in-repo callers, behaviour change, missing tests and lines changed. The agent’s own judgement counts for a small, capped share. The bars ',
        swatch(16, 12, meterIcon(3)),
        ' repeat the band without colour.',
      ),
    ),
    h('h4', {}, 'Shapes'),
    h(
      'dl',
      {},
      row(swatch(44, 24, s('rect', { class: 'legend-stack', x: 5, y: 5, width: 36, height: 17, rx: 3 }), s('rect', { class: 'legend-node', x: 1, y: 1, width: 36, height: 17, rx: 3 })), 'Module', 'A folder of related code. Click it, or press →, to open it and see the functions inside.'),
      row(swatch(44, 24, s('rect', { class: 'legend-node', x: 1, y: 3, width: 40, height: 17, rx: 3 })), 'Function', 'A symbol this PR changes, or unchanged code you need to understand it.'),
      row(swatch(44, 24, s('rect', { class: 'legend-external', x: 1, y: 3, width: 40, height: 17, rx: 3 })), 'Outside this repo', 'Another repo that uses this code. These are the breakages a diff alone won’t show you.'),
    ),
    h('h4', {}, 'Change'),
    h(
      'dl',
      { class: 'legend-changes' },
      row(changeBadge('ADDED', 'added'), '', 'New in this PR.'),
      row(changeBadge('MODIFIED', 'modified'), '', 'Changed by this PR.'),
      row(changeBadge('REMOVED', 'removed'), '', 'Deleted by this PR.'),
      row(changeBadge('UNCHANGED', 'context'), '', 'Not changed, but needed to understand the change.'),
    ),
    h('h4', {}, 'Lines'),
    h(
      'dl',
      {},
      row(edgeSwatch('calls'), 'Calls', 'The arrow points at the code being called.'),
      row(edgeSwatch('consumes'), 'Used from outside', 'Another repo uses the code the arrow points at.'),
      row(edgeSwatch('imports'), 'Imports', 'Depends on it without calling it (types, constants).'),
      row(edgeSwatch('calls', 2), 'Grouped', 'Several connections inside a closed module. Open it to see each one.'),
    ),
    h(
      'dl',
      {},
      row(swatch(16, 14, s('g', { class: 'visited-mark', transform: 'translate(2,1)' }, s('circle', { cx: 6, cy: 6, r: 6 }), s('path', { d: 'M3 6.2 L5.2 8.4 L9 4.2' }))), 'Seen', 'You have looked at this already.'),
    ),
  );
}

function meterIcon(filled: number): SVGGElement {
  const g = s('g', { class: 'meter' });
  for (let i = 0; i < 3; i++) g.append(s('rect', { x: 1 + i * 5, y: 7 - i * 3, width: 3.5, height: 4 + i * 3, rx: 1, class: i < filled ? 'on' : 'off' }));
  return g;
}

function changeBadge(text: string, change: string): HTMLElement {
  return h('span', { class: `change-badge change--${change}` }, text);
}

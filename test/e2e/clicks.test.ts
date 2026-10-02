// The review webview used the way a person uses it: real mouse clicks and key presses into the
// VS Code window (over DevTools, see cdp.ts), checked against what the webview draws, what the host
// opens in the editor, and what ends up on screen.

import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { scoreGraph } from '../../src/contract/risk';
import type { CodePaneSnapshot } from '../../src/host/codePane';
import type { Workbench } from './cdp';
import {
  assertAnchorsVisible,
  assertFoldedOnScreen,
  cdpPort,
  editorFor,
  expectedFolds,
  externals,
  filos,
  modules,
  node,
  nodeSel,
  renderedAfter,
  sampleGraph,
  shot,
  sleep,
  waitFor,
  workbench,
} from './helpers';

/** Waits until the code pane has finished opening `id`: folds applied and focus back on the graph. */
export async function codeShown(id: string, file: string): Promise<CodePaneSnapshot> {
  const api = await filos();
  const snap = await waitFor(
    () => {
      const s = api.getCodePane();
      const folded = s.foldAttempts > 0 || (!s.folded.length && !s.unfolded.length);
      return s.nodeId === id && s.file === file && folded && api.getPanel()?.active ? s : undefined;
    },
    `the code pane to show ${id} in ${file}`,
    15_000,
  );
  await sleep(150);
  return snap;
}

/** The graph is drawn and its transitions (about 220 ms) have settled, so boxes are where they'll stay. */
export async function graphSettled(wb: Workbench): Promise<void> {
  await wb.waitForWebview(`(d) => !!d.querySelector('.layer-nodes [data-node-id]') && d.querySelector('.graph-placeholder')?.hidden !== false && !d.querySelector('.review')?.hidden`, 'the graph', 15_000);
  await sleep(400);
}

const summaryTitle = (wb: Workbench) => wb.evalWebview<string>(`(d) => d.querySelector('.summary-title')?.textContent ?? ''`);
/** The node with keyboard focus, or what has focus instead (e.g. "BODY"). */
const focusedNode = (wb: Workbench) =>
  wb.evalWebview<string>(`(d) => { const a = d.activeElement; return a?.closest?.('[data-node-id]')?.dataset.nodeId ?? ('<' + (a ? a.tagName + (a.className && typeof a.className === 'string' ? '.' + a.className.split(' ')[0] : '') : 'none') + (d.hasFocus() ? '' : ', page not focused') + '>'); }`);
const isNodeId = (f: string) => !f.startsWith('<');

/**
 * Gists the editor actually draws for a file: the ::after text of decorated spans on screen.
 * Read from VS Code's own DOM, so this checks the screen rather than the host's bookkeeping.
 */
export function gistsDrawn(wb: Workbench, relPath: string): Promise<string[]> {
  return wb.evalPage<string[]>(`(() => {
    const eds = [...document.querySelectorAll('.monaco-editor[data-uri]')].filter((e) => decodeURIComponent(e.getAttribute('data-uri')).endsWith(${JSON.stringify('/' + relPath)}));
    const out = [];
    for (const ed of eds) for (const el of ed.querySelectorAll('.view-lines span')) {
      const c = getComputedStyle(el, '::after').content;
      if (c && c !== 'none' && c !== 'normal') out.push(c);
    }
    return out;
  })()`);
}

/** Folded-region markers VS Code draws in the gutter of a file's editor. */
export function foldMarkersDrawn(wb: Workbench, relPath: string): Promise<number> {
  return wb.evalPage<number>(`(() => {
    const eds = [...document.querySelectorAll('.monaco-editor[data-uri]')].filter((e) => decodeURIComponent(e.getAttribute('data-uri')).endsWith(${JSON.stringify('/' + relPath)}));
    return eds.reduce((n, ed) => n + ed.querySelectorAll('.codicon-folding-collapsed, .codicon-folding-manual-collapsed').length, 0);
  })()`);
}

export function registerClickTests(): void {
  describe('Review webview, clicked with the real mouse', function () {
    let wb: Workbench;
    const rc = () => node('money/roundToCents');

    before(async function () {
      if (!cdpPort()) this.skip();
      wb = await workbench();
      const t0 = Date.now();
      await vscode.commands.executeCommand('filos.reviewSample');
      await renderedAfter(t0, (r) => r.visibleNodes.length > 0, 20_000);
      await graphSettled(wb);
    });

    it('Collapse all and a click on empty canvas bring back the first screen', async () => {
      let t = Date.now();
      await wb.clickWebview('.toolbar button', { text: 'Collapse all' });
      let r = await renderedAfter(t, (x) => x.expanded.length === 0);
      if (r.selected) {
        await sleep(300);
        t = Date.now();
        await wb.clickGraphBackground();
        r = await renderedAfter(t, (x) => x.selected === undefined);
      }
      assert.deepEqual([...r.visibleNodes].sort(), [...modules(), ...externals()].sort());
      assert.equal(await summaryTitle(wb), 'What this PR touches');
      await graphSettled(wb);
      await shot('click-first-screen');
    });

    it('clicking a closed module selects it, opens it in the graph and shows its code beside', async () => {
      const t = Date.now();
      await wb.clickWebview(nodeSel('money'), { avoid: '[data-chevron]' });
      const r = await renderedAfter(t, (x) => x.selected === 'money' && x.expanded.includes('money'));
      for (const child of ['money/roundToCents', 'money/Money.multiply', 'money/Money.allocate']) assert.ok(r.visibleNodes.includes(child), `${child} not drawn after opening money`);

      const file = node('money').anchors[0].file;
      await codeShown('money', file);
      const ed = editorFor(file);
      assert.ok(ed, `${file} not visible`);
      assert.equal(ed.viewColumn, vscode.ViewColumn.Two);
      assert.equal(await summaryTitle(wb), 'money');
      await graphSettled(wb);
      await shot('click-money');
    });

    it('clicking a function shows its code, its risk broken into signals, and its anchors', async () => {
      const t = Date.now();
      await wb.clickWebview(nodeSel(rc().id));
      await renderedAfter(t, (x) => x.selected === rc().id);
      const snap = await codeShown(rc().id, 'src/money/round.ts');
      assert.equal(snap.highlights.length, 2);
      assertAnchorsVisible(editorFor('src/money/round.ts')!, 'src/money/round.ts', rc().anchors);

      const card = await wb.evalWebview<{ title: string; score: string; band: string; chips: number; anchors: string[] }>(`(d) => ({
        title: d.querySelector('.summary-title')?.textContent,
        score: d.querySelector('.risk-card .risk-score')?.textContent,
        band: d.querySelector('.risk-card')?.className,
        chips: d.querySelectorAll('.risk-card .chip').length,
        anchors: [...d.querySelectorAll('.anchors .anchor-file')].map((e) => e.textContent),
      })`);
      const risk = scoreGraph(sampleGraph()).get(rc().id)!;
      assert.equal(card.title, rc().label);
      assert.equal(card.score, risk.level.toFixed(2));
      assert.match(card.band, new RegExp(`band-${risk.band}\\b`));
      assert.ok(card.chips >= 3, `only ${card.chips} risk chips`);
      assert.deepEqual(
        card.anchors,
        rc().anchors.map((a) => `${a.file}:${a.startLine === a.endLine ? a.startLine : `${a.startLine}–${a.endLine}`}`),
      );
      await graphSettled(wb);
      await shot('click-roundToCents');
    });

    it('a file link in the summary opens that anchor, folded down to gists drawn in the editor', async () => {
      const file = rc().anchors[2].file;
      await wb.clickWebview('.anchors [data-anchor-index="2"]');
      const snap = await codeShown(rc().id, file);
      const ed = editorFor(file);
      assert.ok(ed, `${file} not visible`);
      const expected = expectedFolds(file, rc().anchors);
      assert.ok(snap.foldVerified, 'folds not confirmed');
      assert.ok(assertFoldedOnScreen(ed, expected) >= 1);
      assertAnchorsVisible(ed, file, rc().anchors);

      const drawn = await waitFor(async () => {
        const d = await gistsDrawn(wb, file);
        return d.length >= expected.length ? d : undefined;
      }, `gists drawn in ${file}`);
      for (const r of expected) assert.ok(drawn.some((c) => c.includes(r.gist.slice(0, 30))), `no gist drawn for ${r.startLine}-${r.endLine} "${r.gist}"; drawn: ${drawn.join(' | ')}`);
      assert.equal(await foldMarkersDrawn(wb, file), expected.length, 'one folded marker per folded region');
      await shot('click-anchor-link-test-file');
    });

    it('clicking an outside consumer keeps the code as it is and says where it lives', async () => {
      const ext = 'ext/payouts-service';
      const before = vscode.window.visibleTextEditors.map((e) => `${e.viewColumn}:${e.document.uri.toString()}`);
      const t = Date.now();
      await wb.clickWebview(nodeSel(ext));
      await renderedAfter(t, (x) => x.selected === ext);
      await sleep(600); // room for the host to (wrongly) open something
      assert.deepEqual(
        vscode.window.visibleTextEditors.map((e) => `${e.viewColumn}:${e.document.uri.toString()}`),
        before,
      );
      const api = await filos();
      assert.equal(api.getCodePane().nodeId, undefined);
      assert.equal(await summaryTitle(wb), node(ext).label);
      assert.ok(await wb.evalWebview<boolean>(`(d) => !!d.querySelector('.kind-tag--external')`), 'summary does not mark it as outside this repo');
      await shot('click-external');
    });

    it("a module's chevron closes it without changing the selection", async () => {
      await graphSettled(wb);
      const t = Date.now();
      await wb.clickWebview(`${nodeSel('money')} [data-chevron]`);
      const r = await renderedAfter(t, (x) => !x.expanded.includes('money'));
      assert.equal(r.selected, 'ext/payouts-service');
      assert.ok(!r.visibleNodes.includes(rc().id), 'children still drawn after closing money');
    });

    it('toolbar: zoom in and out, Fit, Expand all and Collapse all', async () => {
      await graphSettled(wb);
      const zoom = async () => Number((await wb.evalWebview<string>(`(d) => d.querySelector('.zoom-readout').textContent`)).replace('%', ''));
      const z0 = await zoom();
      await wb.clickWebview('.toolbar button[aria-label="Zoom in"]');
      const z1 = await waitFor(async () => ((await zoom()) !== z0 ? zoom() : undefined), 'zoom readout to change');
      assert.ok(Math.abs(z1 - z0 * 1.25) <= 1.5, `zoom in: ${z0}% -> ${z1}%`);
      await wb.clickWebview('.toolbar button[aria-label="Zoom out"]');
      const z2 = await waitFor(async () => ((await zoom()) !== z1 ? zoom() : undefined), 'zoom readout to change back');
      assert.ok(Math.abs(z2 - z0) <= 1.5, `zoom out: ${z1}% -> ${z2}% (started at ${z0}%)`);
      await wb.clickWebview('.toolbar button[aria-label="Zoom in"]');
      await wb.clickWebview('.toolbar button[aria-label="Zoom in"]');
      await wb.clickWebview('.toolbar button', { text: 'Fit' });
      await waitFor(async () => (await zoom()) <= z0 + 1, 'Fit to bring the whole graph back into view');

      let t = Date.now();
      await wb.clickWebview('.toolbar button', { text: 'Expand all' });
      let r = await renderedAfter(t, (x) => modules().every((m) => x.expanded.includes(m)));
      assert.equal(r.visibleNodes.length, sampleGraph().nodes.length, 'every node is drawn once all modules are open');
      await graphSettled(wb);
      await shot('click-expand-all');
      t = Date.now();
      await wb.clickWebview('.toolbar button', { text: 'Collapse all' });
      r = await renderedAfter(t, (x) => x.expanded.length === 0);
      assert.equal(r.visibleNodes.length, modules().length + externals().length);
    });

    it('"Where to look first" lists the riskiest symbol first, and clicking it opens its code', async () => {
      await graphSettled(wb);
      let t = Date.now();
      await wb.clickGraphBackground();
      await renderedAfter(t, (x) => x.selected === undefined);
      const first = await wb.evalWebview<string>(`(d) => d.querySelector('.first-look .node-link')?.dataset.select`);
      const scores = scoreGraph(sampleGraph());
      const riskiest = sampleGraph()
        .nodes.filter((n) => n.parent && n.kind !== 'external' && n.kind !== 'module')
        .sort((a, b) => scores.get(b.id)!.level - scores.get(a.id)!.level)[0];
      assert.equal(first, riskiest.id);

      t = Date.now();
      await wb.clickWebview('.first-look .node-link');
      const r = await renderedAfter(t, (x) => x.selected === riskiest.id);
      assert.ok(r.expanded.includes(riskiest.parent!), 'its module was opened to show it');
      await codeShown(riskiest.id, riskiest.anchors[0].file);
    });

    it('the Overview breadcrumb goes back to the overview', async () => {
      const t = Date.now();
      await wb.clickWebview('.crumbs .crumb', { text: 'Overview' });
      await renderedAfter(t, (x) => x.selected === undefined);
      assert.equal(await summaryTitle(wb), 'What this PR touches');
    });

    it('keyboard alone: Tab reaches the graph, Home/arrows move between boxes, → opens a module, ← closes it, Enter selects', async () => {
      await graphSettled(wb);
      // Start with every module closed, from a toolbar button (a click focuses it), then Tab into the graph.
      const api = await filos();
      if (api.getLastRendered()?.expanded.length) {
        const t0 = Date.now();
        await wb.clickWebview('.toolbar button', { text: 'Collapse all' });
        await renderedAfter(t0, (x) => x.expanded.length === 0, 5_000, 'every module closed');
        await graphSettled(wb);
      }
      await wb.clickWebview('.toolbar button', { text: 'Fit' });
      let focused = await focusedNode(wb);
      for (let i = 0; i < 6 && !isNodeId(focused); i++) {
        await wb.press('Tab');
        focused = await focusedNode(wb);
      }
      assert.ok(isNodeId(focused), `Tab never reached a graph node (focus: ${focused})`);

      await wb.press('Home');
      const first = await focusedNode(wb);
      assert.ok(isNodeId(first), `Home: focus ${first}`);
      await wb.press('ArrowDown');
      const second = await waitFor(async () => {
        const f = await focusedNode(wb);
        return isNodeId(f) && f !== first ? f : undefined;
      }, 'ArrowDown to move focus to the next box', 3_000);
      await wb.press('ArrowUp');
      await waitFor(async () => (await focusedNode(wb)) === first, 'ArrowUp to move focus back', 3_000);

      const mod = modules().includes(first) ? first : modules()[0];
      if (mod !== first) assert.fail(`expected the first box to be a module, got ${first} (then ${second})`);
      let t = Date.now();
      await wb.press('ArrowRight');
      await renderedAfter(t, (x) => x.expanded.includes(mod), 5_000, `${mod} opened by ArrowRight`);
      await sleep(300);
      await wb.press('ArrowRight');
      const child = await waitFor(async () => {
        const f = await focusedNode(wb);
        return isNodeId(f) && node(f).parent === mod ? f : undefined;
      }, `ArrowRight to move into ${mod}`, 3_000);
      await wb.press('ArrowLeft');
      await waitFor(async () => (await focusedNode(wb)) === mod, `ArrowLeft from ${child} back to ${mod}`, 3_000);
      t = Date.now();
      await wb.press('ArrowLeft');
      await renderedAfter(t, (x) => !x.expanded.includes(mod), 5_000, `${mod} closed by ArrowLeft`);
      await sleep(300);

      t = Date.now();
      await wb.press('Enter');
      await renderedAfter(t, (x) => x.selected === mod && x.expanded.includes(mod), 5_000, `${mod} selected and opened by Enter`);
      await codeShown(mod, node(mod).anchors[0].file);
    });

    it('after a click, keyboard focus is back on the clicked box, so arrows and Esc keep working', async () => {
      await graphSettled(wb);
      let t = Date.now();
      await wb.clickWebview(nodeSel('tax'), { avoid: '[data-chevron]' });
      await renderedAfter(t, (x) => x.selected === 'tax');
      await codeShown('tax', node('tax').anchors[0].file);
      await graphSettled(wb);

      const api = await filos();
      assert.ok(api.getPanel()?.active, 'the panel should be active again once the code is shown');
      const focused = await focusedNode(wb);
      assert.equal(focused, 'tax', `keyboard focus should be on the clicked box once the code is shown, but it is on ${focused}`);
      await wb.press('ArrowDown');
      await waitFor(async () => {
        const f = await focusedNode(wb);
        return isNodeId(f) && f !== 'tax' ? f : undefined;
      }, 'ArrowDown to move focus to another box', 3_000);
      t = Date.now();
      await wb.press('Escape');
      await renderedAfter(t, (x) => x.selected === undefined, 5_000, 'the selection cleared by Escape');
    });
  });
}

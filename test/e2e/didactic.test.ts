// Slice 6 in real VS Code: didactic mode on the sample, clicked with the real mouse. Fog over every
// territory, a gate (familiarity, then a prediction) before any code opens, coverage as progress,
// and confidence kept privately in globalState: one small record per module, nothing else.

import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import type { Workbench } from './cdp';
import { codeShown, graphSettled } from './clicks.test';
import { cdpPort, externals, filos, modules, node, nodeSel, renderedAfter, shot, sleep, waitFor, workbench } from './helpers';
import { cardIn, clearNotifications, closeAllEditors, keySel, qSel, sampleQuestion, snapshotWhere, textOf } from './pane';

interface NodeLook {
  id: string;
  fog?: string;
  label: string;
}

/** Every node box drawn in the graph: its fog state and accessible name. */
function nodesDrawn(wb: Workbench): Promise<NodeLook[]> {
  return wb.evalWebview<NodeLook[]>(
    `(d) => [...d.querySelectorAll('.layer-nodes [data-node-id]')].map((e) => ({ id: e.dataset.nodeId, fog: e.dataset.fog, label: e.getAttribute('aria-label') ?? '' }))`,
  );
}

const fileEditors = () => vscode.window.visibleTextEditors.filter((e) => e.document.uri.scheme === 'file');
const gateShown = (wb: Workbench) => wb.evalWebview<boolean>(`(d) => d.querySelector('.gate')?.hidden === false`);

export function registerDidacticTests(): void {
  describe('Didactic mode on the sample', function () {
    let wb: Workbench;
    /** Presses the toolbar's Fit, so the whole map is on screen, and waits for the graph to settle. */
    const fitWholeGraph = async () => {
      await wb.clickWebview('.toolbar button', { text: 'Fit' });
      await graphSettled(wb);
    };

    before(async function () {
      if (!cdpPort()) this.skip();
      wb = await workbench();
      const api = await filos();
      await clearNotifications();
      await closeAllEditors();
      await api.resetStoredState();
      const t0 = Date.now();
      await vscode.commands.executeCommand('filos.reviewSample');
      await renderedAfter(t0, (r) => r.visibleNodes.length > 0, 20_000);
      await graphSettled(wb);
    });

    after(async () => {
      // Leave the global mode as the other suites expect it.
      const api = await filos();
      if (api.getReviewSnapshot()?.mode === 'didactic') await api.dispatchReviewAction({ type: 'setMode', mode: 'fast' });
    });

    it('switching to Didactic fogs every territory and dims the outside consumers', async () => {
      const api = await filos();
      assert.equal(api.getReviewSnapshot()?.mode, 'fast');
      await wb.clickWebview('.mode-switch [data-mode="didactic"]');
      const s = await snapshotWhere((x) => x.mode === 'didactic', 'didactic mode');
      assert.deepEqual(s.coverage, { explored: 0, total: 4 });
      assert.equal(api.getGlobalState()['filos.mode'], 'didactic', 'the mode is kept globally');

      const drawn = await wb.waitForWebview<NodeLook[]>(
        `(d) => { const n = [...d.querySelectorAll('.layer-nodes [data-node-id]')]; return n.length && n.every((e) => e.dataset.fog) && n.map((e) => ({ id: e.dataset.nodeId, fog: e.dataset.fog, label: e.getAttribute('aria-label') })); }`,
        'the fog',
      );
      assert.deepEqual(drawn.map((n) => n.id).sort(), [...modules(), ...externals()].sort(), 'only the territories and outside consumers are drawn');
      for (const id of modules()) {
        const n = drawn.find((x) => x.id === id)!;
        assert.equal(n.fog, 'fogged', id);
        assert.equal(n.label, `${node(id).label}, unexplored territory`);
      }
      for (const id of externals()) assert.equal(drawn.find((x) => x.id === id)!.fog, 'dimmed', id);
      assert.equal(await textOf(wb, '.coverage-text'), 'Explored 0 of 4 territories');
      assert.ok(await wb.evalWebview<boolean>(`(d) => !!d.querySelector('.socrates')`), 'Socrates is on the map');
      await graphSettled(wb);
      await shot('didactic-fog');
    });

    it('clicking a fogged territory opens its gate, not its code', async () => {
      const api = await filos();
      await wb.clickWebview(nodeSel('money'));
      const s = await snapshotWhere((x) => x.gate?.nodeId === 'money', 'the gate into money');
      assert.deepEqual(s.gate, { nodeId: 'money', step: 'familiarity' });
      await wb.waitForWebview<boolean>(`(d) => d.querySelector('.gate')?.hidden === false && d.querySelectorAll('.gate [data-familiarity]').length === 3`, 'the gate in the pane');
      assert.equal(await textOf(wb, '.gate .gate-title'), 'money');
      assert.equal(await textOf(wb, '.gate .gate-ask'), 'Have you worked with money before?');
      // Room for the host to (wrongly) open code.
      await sleep(600);
      assert.deepEqual(fileEditors().map((e) => e.document.fileName), [], 'no code opens before the prediction');
      assert.equal(api.getCodePane().nodeId, undefined);
      const r = api.getLastRendered();
      assert.ok(r);
      assert.ok(!r.expanded.includes('money'), 'a fogged territory does not open in the graph');
      assert.notEqual(r.selected, 'money');
      await shot('didactic-gate');
    });

    it('familiarity, then the prediction, then Continue opens the territory and its code; coverage 1 of 4', async () => {
      const api = await filos();
      await wb.clickWebview('.gate [data-familiarity="some"]');
      let s = await snapshotWhere((x) => x.gate?.step === 'predict', 'the prediction step');
      const q = sampleQuestion('q-money-predict');
      assert.equal(s.gate?.questionId, q.id);
      await cardIn(wb, q.id, 'new', '.gate');

      const right = q.choices!.find((c) => c.correct)!;
      await wb.clickWebview(`.gate ${qSel(q.id)} [data-choice-id="${right.id}"]`);
      await cardIn(wb, q.id, 'done', '.gate');
      s = await snapshotWhere((x) => !!x.territories.find((t) => t.nodeId === 'money')?.explored, 'money explored');
      assert.deepEqual(s.coverage, { explored: 1, total: 4 });
      assert.equal(await textOf(wb, '.gate .gate-continue strong'), '✓ Explored money.');
      assert.deepEqual(fileEditors(), [], 'still no code until Continue');

      const t = Date.now();
      await wb.clickWebview(keySel('gate:continue'));
      const file = node('money').anchors[0].file;
      await codeShown('money', file);
      const r = await renderedAfter(t, (x) => x.selected === 'money' && x.expanded.includes('money'), 10_000, 'money selected and open');
      for (const child of ['money/roundToCents', 'money/Money.multiply']) assert.ok(r.visibleNodes.includes(child), `${child} is drawn inside money`);
      s = await snapshotWhere((x) => !x.gate, 'the gate to close');
      await wb.waitForWebview<boolean>(`(d) => d.querySelector('.gate')?.hidden === true`, 'the gate to leave the pane', 3_000);
      assert.equal(await textOf(wb, '.coverage-text'), 'Explored 1 of 4 territories');
      const drawn = await nodesDrawn(wb);
      assert.equal(drawn.find((n) => n.id === 'money')?.fog, undefined, 'money is out of the fog');
      assert.equal(drawn.find((n) => n.id === 'invoice')?.fog, 'fogged');
      // Exploring money reveals the consumers that only use money.
      assert.equal(drawn.find((n) => n.id === 'ext/checkout-web')?.fog, undefined);
      assert.equal(drawn.find((n) => n.id === 'ext/mobile-app')?.fog, 'dimmed', 'mobile-app uses api, still unexplored');
      assert.equal(api.getCodePane().nodeId, 'money');
      await graphSettled(wb);
      await shot('didactic-explored-money');
    });

    it('confidence is kept privately in globalState: one record for the module, and nothing else', async () => {
      const api = await filos();
      const state = api.getGlobalState();
      assert.deepEqual(Object.keys(state).sort(), ['filos.confidence.v1', 'filos.mode'], `globalState holds ${JSON.stringify(state)}`);
      const store = state['filos.confidence.v1'] as Record<string, Record<string, Record<string, unknown>>>;
      assert.deepEqual(Object.keys(store), ['sample:@acme/ledger']);
      assert.deepEqual(Object.keys(store['sample:@acme/ledger']), ['src/money']);
      const record = store['sample:@acme/ledger']['src/money'];
      assert.deepEqual(Object.keys(record).sort(), ['confidence', 'lastTouched'], 'module path, confidence and last-touched date only');
      // "Somewhat" starts at 0.5; a right first prediction adds 0.15.
      assert.ok(Math.abs((record.confidence as number) - 0.65) < 1e-9, `confidence ${record.confidence}`);
      assert.ok(!Number.isNaN(Date.parse(record.lastTouched as string)), `lastTouched ${record.lastTouched}`);
      assert.ok(Date.now() - Date.parse(record.lastTouched as string) < 5 * 60_000, 'touched just now');
      const s = await snapshotWhere(() => true, 'a snapshot');
      assert.equal(s.territories.find((t) => t.nodeId === 'money')?.confidence, record.confidence);
    });

    it('a territory still in fog opens its own gate; "Not now" leaves the code as it was', async () => {
      const api = await filos();
      await graphSettled(wb);
      // The automatic fit keeps the selection (money) readable and, in a pane this narrow, crops
      // invoice off the left edge. Fit shows the whole map first, as a person would.
      await fitWholeGraph();
      await wb.clickWebview(nodeSel('invoice'));
      await snapshotWhere((x) => x.gate?.nodeId === 'invoice', 'the gate into invoice');
      await waitFor(() => gateShown(wb), 'the gate in the pane');
      await sleep(400);
      assert.equal(api.getCodePane().nodeId, 'money', 'the code pane still shows money');

      await wb.clickWebview(keySel('gate:cancel'));
      await snapshotWhere((x) => !x.gate, 'the gate to close');
      await waitFor(async () => !(await gateShown(wb)), 'the gate to leave the pane');
      assert.equal(api.getCodePane().nodeId, 'money');
      assert.ok(!(await snapshotWhere(() => true, 'a snapshot')).territories.find((t) => t.nodeId === 'invoice')?.explored);
    });

    it('switching back to Fast lifts the fog, and any module opens again', async () => {
      const api = await filos();
      await wb.clickWebview('.mode-switch [data-mode="fast"]');
      await snapshotWhere((x) => x.mode === 'fast', 'fast mode');
      assert.equal(api.getGlobalState()['filos.mode'], 'fast');
      await wb.waitForWebview<boolean>(`(d) => d.querySelectorAll('.layer-nodes [data-fog]').length === 0 && d.querySelector('.coverage')?.hidden === true`, 'the fog to lift', 5_000);
      await graphSettled(wb);
      await fitWholeGraph();

      const t = Date.now();
      await wb.clickWebview(nodeSel('invoice'), { avoid: '[data-chevron]' });
      await renderedAfter(t, (x) => x.selected === 'invoice');
      await codeShown('invoice', node('invoice').anchors[0].file);
      await shot('didactic-back-to-fast');
    });
  });
}

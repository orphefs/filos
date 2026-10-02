// The bundled sample, driven through the extension's test API: the first screen, then selections
// that open code beside the graph with unrelated regions folded down to gists.

import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import {
  assertAnchorsVisible,
  assertFoldedOnScreen,
  editorFor,
  expectedFolds,
  externals,
  filos,
  modules,
  node,
  renderedAfter,
  SAMPLE_TITLE,
  shot,
} from './helpers';

const sorted = (xs: readonly string[]) => [...xs].sort();
const starts = (rs: readonly { startLine: number }[]) => rs.map((r) => r.startLine).sort((a, b) => a - b);

export function registerSampleTests(): void {
  describe('Sample review (test API)', () => {
    it('filos.reviewSample opens the Filos panel on the first screen: modules and outside consumers, nothing expanded', async () => {
      const api = await filos();
      const t0 = Date.now();
      await vscode.commands.executeCommand('filos.reviewSample');

      const panel = api.getPanel();
      assert.ok(panel, 'no review panel');
      assert.equal(panel.viewType, 'filos.review');
      assert.equal(panel.title, `Filos: ${SAMPLE_TITLE}`);
      assert.equal(panel.viewColumn, vscode.ViewColumn.One);
      assert.ok(panel.visible, 'panel not visible');
      const session = api.getSession();
      assert.ok(session);
      assert.deepEqual(session.status, { kind: 'loaded' });
      assert.equal(session.source, 'fixture');
      assert.equal(session.target.kind, 'sample');
      assert.equal(session.nodeIds.length, 17);

      const r = await renderedAfter(t0, (x) => x.visibleNodes.length > 0, 20_000);
      assert.ok(api.isWebviewReady(), 'webview never said ready');
      const tabs = vscode.window.tabGroups.all.flatMap((g) => g.tabs);
      const tab = tabs.find((t) => t.input instanceof vscode.TabInputWebview && t.input.viewType.endsWith(panel.viewType));
      assert.ok(tab, `no editor tab for the panel; tabs: ${JSON.stringify(tabs.map((t) => [t.label, t.input?.constructor?.name, (t.input as { viewType?: string })?.viewType]))}`);
      assert.equal(tab.label, panel.title);
      assert.equal(tab.group.viewColumn, vscode.ViewColumn.One);
      assert.deepEqual(sorted(r.visibleNodes), sorted([...modules(), ...externals()]));
      assert.deepEqual(sorted(modules()), ['api', 'invoice', 'money', 'tax']);
      assert.equal(externals().length, 4);
      assert.deepEqual(r.expanded, []);
      assert.equal(r.selected, undefined);
      // The first screen is the graph alone: no code opened yet.
      assert.equal(vscode.window.visibleTextEditors.length, 0, `editors open: ${vscode.window.visibleTextEditors.map((e) => e.document.fileName)}`);
      await shot('first-screen');
    });

    it('selecting the money module opens its code in column two and folds what is unrelated', async () => {
      const api = await filos();
      const money = node('money');
      await api.simulateSelect('money');

      let snap = api.getCodePane();
      const first = money.anchors[0];
      assert.equal(snap.nodeId, 'money');
      assert.equal(snap.file, first.file);
      const ed = editorFor(first.file);
      assert.ok(ed, `${first.file} is not visible`);
      assert.equal(ed.viewColumn, vscode.ViewColumn.Two);
      assert.deepEqual(starts(snap.folded), starts(expectedFolds(first.file, money.anchors)));
      assertAnchorsVisible(ed, first.file, money.anchors);

      // round.ts has nothing multi-line besides the anchor, so check folding on the module's other
      // file, money.ts, where most of the class is unrelated.
      await api.simulateOpenAnchor('money', 1);
      snap = api.getCodePane();
      const file = money.anchors[1].file;
      assert.equal(snap.file, file);
      const ed2 = editorFor(file);
      assert.ok(ed2, `${file} is not visible`);
      assert.equal(ed2.viewColumn, vscode.ViewColumn.Two);
      assert.equal(editorFor(first.file), undefined, `${first.file} should have been replaced (preview tab)`);
      const expected = expectedFolds(file, money.anchors);
      assert.ok(expected.length >= 5, 'fixture changed: money.ts should have unrelated regions');
      assert.deepEqual(starts(snap.folded), starts(expected));
      assert.ok(snap.foldVerified, `folds not confirmed on screen after ${snap.foldAttempts} attempt(s)`);
      assert.ok(assertFoldedOnScreen(ed2, expected) >= 3, 'fewer than 3 folded regions could be checked on screen');
      assertAnchorsVisible(ed2, file, money.anchors);
      await shot('money-ts-folded');
    });

    it('selecting the money module also opens it in the graph, as a click does', async () => {
      const api = await filos();
      const t = Date.now();
      await api.simulateSelect('money');
      const r = await renderedAfter(t, (x) => x.selected === 'money', 5_000, 'money selected');
      assert.ok(r.expanded.includes('money'), `host-driven select of a module left it closed in the graph: expanded=${JSON.stringify(r.expanded)}`);
    });

    it('selecting roundToCents shows round.ts with its anchors on screen, and its test file folded down to gists', async () => {
      const api = await filos();
      const rc = node('money/roundToCents');
      const t0 = Date.now();
      await api.simulateSelect(rc.id);

      let snap = api.getCodePane();
      assert.equal(snap.nodeId, rc.id);
      assert.equal(snap.file, 'src/money/round.ts');
      const ed = editorFor('src/money/round.ts');
      assert.ok(ed, 'round.ts is not visible');
      assert.equal(ed.viewColumn, vscode.ViewColumn.Two);
      assertAnchorsVisible(ed, 'src/money/round.ts', rc.anchors);
      // Both anchors in the file are tinted, in the top risk bucket (roundToCents scores 0.8).
      assert.deepEqual(
        snap.highlights.map((h) => `${h.startLine}-${h.endLine}`).sort(),
        rc.anchors.filter((a) => a.file === 'src/money/round.ts').map((a) => `${a.startLine}-${a.endLine}`).sort(),
      );
      assert.ok(snap.highlights.every((h) => h.bucket === 4), `risk buckets ${snap.highlights.map((h) => h.bucket)}`);
      // Everything else in round.ts is a one-line declaration, so nothing there can fold.
      assert.deepEqual(expectedFolds('src/money/round.ts', rc.anchors), []);
      assert.deepEqual(snap.folded, []);
      const rendered = await renderedAfter(t0, (x) => x.selected === rc.id, 5_000);
      assert.ok(rendered.visibleNodes.includes(rc.id), 'roundToCents not drawn in the graph');

      // Its third anchor is the test file: there the unrelated tests fold, each with its gist.
      const testFile = rc.anchors[2].file;
      assert.equal(testFile, 'test/round.test.ts');
      await api.simulateOpenAnchor(rc.id, 2);
      snap = api.getCodePane();
      assert.equal(snap.file, testFile);
      const ted = editorFor(testFile);
      assert.ok(ted, `${testFile} is not visible`);
      const expected = expectedFolds(testFile, rc.anchors);
      assert.deepEqual(starts(snap.folded), starts(expected));
      assert.ok(snap.foldVerified, `folds not confirmed on screen after ${snap.foldAttempts} attempt(s)`);
      assert.ok(assertFoldedOnScreen(ted, expected) >= 1, 'no folded region could be checked on screen');
      assertAnchorsVisible(ted, testFile, rc.anchors);
      assert.deepEqual(
        snap.gists.sort((a, b) => a.line - b.line),
        expected.map((r) => ({ line: r.startLine, gist: r.gist })),
        'every folded region carries its gist, and only those',
      );
      await shot('round-test-folded');
    });

    it('selecting an outside consumer leaves the code pane as it was', async () => {
      const api = await filos();
      await api.simulateSelect('money/Money.multiply');
      const before = vscode.window.visibleTextEditors.map((e) => `${e.viewColumn}:${e.document.uri.toString()}`);
      const gists = api.getCodePane().gists;
      assert.ok(gists.length > 0, 'expected gists on money.ts before selecting the external');

      const t0 = Date.now();
      await assert.doesNotReject(api.simulateSelect('ext/checkout-web'));
      const r = await renderedAfter(t0, (x) => x.selected === 'ext/checkout-web', 5_000);
      assert.ok(r.visibleNodes.includes('ext/checkout-web'));

      const after = vscode.window.visibleTextEditors.map((e) => `${e.viewColumn}:${e.document.uri.toString()}`);
      assert.deepEqual(after, before, 'the external replaced or closed the code');
      const snap = api.getCodePane();
      assert.equal(snap.nodeId, undefined, 'the external has no code, so nothing is selected in the code pane');
      assert.equal(snap.file, 'src/money/money.ts');
      assert.deepEqual(snap.highlights, [], 'the highlight is dropped');
      assert.deepEqual(snap.gists, gists, 'the folds keep their gists');
    });
  });
}

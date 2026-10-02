// "Review Current Branch" on the workspace runE2E prepares: the sample's base on main, its head
// committed on feature/x, and one uncommitted edit. Then closing the panel ends the review.

import * as assert from 'node:assert/strict';
import { realpathSync } from 'node:fs';
import { sep } from 'node:path';
import * as vscode from 'vscode';
import type { Workbench } from './cdp';
import { codeShown, graphSettled } from './clicks.test';
import { cdpPort, editorFor, filos, nodeSel, renderedAfter, SAMPLE_TITLE, shot, waitFor, workbench } from './helpers';

export function registerBranchTests(): void {
  describe('Review Current Branch', function () {
    let wb: Workbench | undefined;
    let workspace: string;

    before(async function () {
      const ws = process.env.FILOS_E2E_WORKSPACE;
      if (!ws || !process.env.FILOS_E2E_FAKE_CLAUDE) this.skip();
      workspace = realpathSync(ws);
      assert.equal(vscode.workspace.workspaceFolders?.[0]?.uri.fsPath, ws, 'the test workspace is not open');
      process.env.FAKE_CLAUDE_MODE = 'ok';
      if (cdpPort()) wb = await workbench();
    });

    it("reviews the workspace's branch against main and warns that uncommitted changes are left out", async () => {
      const api = await filos();
      const t0 = Date.now();
      await vscode.commands.executeCommand('filos.reviewCurrentBranch');
      const s = api.getSession();
      assert.ok(s);
      assert.deepEqual(s.status, { kind: 'loaded' });
      assert.equal(s.source, 'agent');
      assert.deepEqual({ kind: s.target.kind, base: s.target.base, head: s.target.head, repoRoot: s.target.repoRoot }, { kind: 'branch', base: 'main', head: 'feature/x', repoRoot: workspace });
      assert.ok(s.warnings.some((w) => /uncommitted/.test(w)), `warnings: ${JSON.stringify(s.warnings)}`);
      // One commit on the branch, so its subject is the title.
      assert.equal(api.getPanel()?.title, `Filos: ${SAMPLE_TITLE}`);
      await renderedAfter(t0, (x) => x.visibleNodes.length > 0, 20_000);

      if (!wb) return;
      await graphSettled(wb);
      const head = await wb.evalWebview<string>(`(d) => d.querySelector('.pr-meta .branch')?.textContent ?? ''`);
      assert.equal(head, 'feature/x → main');
      await wb.clickWebview('.warnings-toggle');
      const listed = await wb.waitForWebview<string[]>(`(d) => { const l = d.querySelector('#filos-warnings'); return l && !l.hidden && [...l.querySelectorAll('li')].map((x) => x.textContent); }`, 'the warnings list');
      assert.ok(listed.some((w) => /uncommitted/.test(w)), `listed: ${JSON.stringify(listed)}`);
      await shot('branch-warnings');
    });

    it('clicking a node opens the code from the workspace repo', async function () {
      if (!wb) this.skip();
      let t = Date.now();
      await wb.clickWebview(nodeSel('invoice'), { avoid: '[data-chevron]' });
      await renderedAfter(t, (x) => x.selected === 'invoice' && x.expanded.includes('invoice'));
      await codeShown('invoice', 'src/invoice/invoice.ts');
      await graphSettled(wb);
      t = Date.now();
      await wb.clickWebview(nodeSel('invoice/applyDiscount'));
      await renderedAfter(t, (x) => x.selected === 'invoice/applyDiscount');
      const snap = await codeShown('invoice/applyDiscount', 'src/invoice/discount.ts');
      const ed = editorFor('src/invoice/discount.ts');
      assert.ok(ed);
      assert.ok(ed.document.uri.fsPath.startsWith(workspace + sep), `opened ${ed.document.uri.fsPath}, expected a file under ${workspace}`);
      assert.ok(snap.foldVerified);
      await shot('branch-applyDiscount');
    });

    it('closing the panel ends the review and closes the code it opened', async () => {
      const api = await filos();
      const panel = api.getPanel();
      assert.ok(panel);
      const file = api.getCodePane().file;
      panel.dispose();
      await waitFor(() => api.getSession() === undefined, 'the session to end');
      if (file) await waitFor(() => !editorFor(file), `the preview of ${file} to close`);
      assert.equal(api.getCodePane().nodeId, undefined);
    });
  });
}

// Slice 4 in real VS Code: the questionnaire, draft comments and Export on the sample; the review
// depth; the agent's small tasks (questions, grading, threads, drafting) with the fake claude CLI;
// and posting to GitHub with the fake gh. The webview is driven with real clicks and typing
// (cdp.ts) wherever the UI is the point; the host's review snapshot and the fakes' records check
// what happened behind it.
//
// The posting confirmation is the one thing not clicked. The host asks with a modal
// (showWarningMessage with modal: true), which blocks the test run and is a native dialog on Linux,
// out of reach of DevTools. Tests answer it through the test API instead: setConfirmAnswer(true)
// for "Post review", false for cancel (ReviewController.confirmOverride), and read back the exact
// text the modal would have shown with getLastConfirmation(). Everything else runs for real.

import * as assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import * as vscode from 'vscode';
import { SEVERITY_LABEL } from '../../src/review/github';
import type { Workbench } from './cdp';
import { graphSettled } from './clicks.test';
import { cdpPort, filos, renderedAfter, SAMPLE_TITLE, shot, sleep, waitFor, workbench } from './helpers';
import {
  cardIds,
  cardIn,
  clearNotifications,
  closeAllEditors,
  cSel,
  draftSel,
  idsAt,
  isDisabled,
  keySel,
  openTab,
  qSel,
  sampleQuestion,
  sampleQuestions,
  snapshot,
  snapshotWhere,
  textOf,
  typeInto,
} from './pane';

const flat = (s: string) => s.replace(/\s+/g, ' ').trim();
const SAMPLE_POST_REASON = "The sample isn't a GitHub pull request. Use Export to copy the review as Markdown.";

/** Opens a review from a clean slate: no stored answers, comments, view state, mode or confidence. */
async function freshReview(wb: Workbench, command: string): Promise<void> {
  const api = await filos();
  await clearNotifications();
  await closeAllEditors();
  await api.resetStoredState();
  const t0 = Date.now();
  await vscode.commands.executeCommand(command);
  await renderedAfter(t0, (r) => r.visibleNodes.length > 0, 20_000);
  await graphSettled(wb);
}

/** The card of a comment, as drawn. */
function commentView(wb: Workbench, id: string): Promise<{ status: string; body: string; origin: string; tags: string[] } | null> {
  return wb.evalWebview(
    `(d, w, f, sel) => {
      const c = d.querySelector(sel);
      if (!c) return null;
      const t = (e) => (e?.textContent ?? '').replace(/\\s+/g, ' ').trim();
      return { status: c.dataset.status, body: t(c.querySelector('.ccard-body')), origin: t(c.querySelector('.ccard-origin')), tags: [...c.querySelectorAll('.ctag')].map(t) };
    }`,
    cSel(id),
  );
}

interface GhCall {
  argv: string[];
  cwd: string;
  mode: string;
  stdin?: string;
}

export function registerReviewTests(): void {
  describe('Questionnaire and comments on the sample (fast mode)', function () {
    let wb: Workbench;

    before(async function () {
      if (!cdpPort()) this.skip();
      wb = await workbench();
      await freshReview(wb, 'filos.reviewSample');
    });

    it('the Questions tab lists the standard-depth questions, in asking order', async () => {
      const s = await snapshotWhere((x) => x.questionsStatus.state === 'ready', 'the sample questions');
      assert.equal(s.mode, 'fast');
      assert.equal(s.agentAvailable, false);
      assert.deepEqual(
        { proposed: s.depth.proposed, chosen: s.depth.chosen, why: s.depth.why },
        { proposed: 'standard', chosen: 'standard', why: sampleQuestions().depth.why },
      );
      const standard = idsAt('standard');
      assert.equal(standard.length, 12, 'fixture changed: 4 skim + 8 standard questions');
      assert.deepEqual(s.questions.map((q) => q.id).sort(), [...standard].sort());

      await openTab(wb, 'questions');
      assert.deepEqual(await cardIds(wb), s.questions.map((q) => q.id), 'one card per question, in the order the host asks them');
      assert.equal(await textOf(wb, '[data-tab="questions"] .tab-count'), `0/${standard.length}`);
      // Riskiest territory first, and its prediction before anything else.
      assert.equal(s.questions[0].id, 'q-money-predict');
      await shot('review-questions');
    });

    it('a multiple-choice question: a wrong answer gets the hint and Try again, the right one its explanation', async () => {
      const q = sampleQuestion('q-multiply-ties');
      const wrong = q.choices!.find((c) => !c.correct)!;
      const right = q.choices!.find((c) => c.correct)!;
      const standard = idsAt('standard').length;

      await wb.clickWebview(`${qSel(q.id)} [data-choice-id="${wrong.id}"]`);
      let card = await cardIn(wb, q.id, 'retry');
      assert.equal(card.verdict, 'retry');
      assert.ok(card.feedback.includes(flat(q.hint!)), `the hint should show; feedback: ${card.feedback}`);
      assert.ok(card.buttons.includes('Try again'), `buttons: ${card.buttons.join(' | ')}`);
      assert.equal((await snapshot()).answers[q.id].done, false);
      await shot('review-mcq-hint');

      // Try again puts focus on the first answer not tried yet.
      await wb.clickWebview(`${qSel(q.id)} button`, { text: 'Try again' });
      const next = q.choices!.find((c) => c.id !== wrong.id)!;
      await wb.waitForWebview<boolean>(`(d, w, f, key) => d.activeElement?.dataset.focusKey === key`, 'focus on the next answer', 3_000, `q:${q.id}:choice:${next.id}`);

      await wb.clickWebview(`${qSel(q.id)} [data-choice-id="${right.id}"]`);
      card = await cardIn(wb, q.id, 'done');
      assert.equal(card.verdict, 'correct');
      assert.ok(card.feedback.includes(flat(right.explain)), `the explanation should show; feedback: ${card.feedback}`);
      const s = await snapshotWhere((x) => !!x.answers[q.id]?.done, `${q.id} done`);
      assert.deepEqual(
        s.answers[q.id].attempts.map((a) => [a.choiceId, a.verdict]),
        [
          [wrong.id, 'incorrect'],
          [right.id, 'correct'],
        ],
      );
      await wb.waitForWebview<boolean>(`(d, w, f, want) => d.querySelector('[data-tab="questions"] .tab-count')?.textContent === want`, 'the answered count to go up', 3_000, `1/${standard}`);
      assert.match(await textOf(wb, '#filos-panel-questions .pane-sub'), new RegExp(`^1 of ${standard} answered`));
    });

    let commentId = '';

    it('a judgement drafts a comment, shown in the Comments tab', async () => {
      const q = sampleQuestion('q-round-default');
      const choice = q.choices!.find((c) => c.id === 'keep-half-up')!;
      const seed = choice.comment!;
      await wb.clickWebview(`${qSel(q.id)} [data-choice-id="${choice.id}"]`);
      const card = await cardIn(wb, q.id, 'done');
      assert.equal(card.verdict, 'noted');

      const s = await snapshotWhere((x) => x.comments.length === 1, 'the drafted comment');
      const c = s.comments[0];
      commentId = c.id;
      assert.deepEqual(
        { file: c.file, line: c.line, severity: c.severity, status: c.status, body: c.body, origin: c.origin, amended: c.amended },
        { file: seed.file, line: seed.line, severity: seed.severity, status: 'draft', body: seed.body, origin: { kind: 'question', questionId: q.id, choiceId: choice.id }, amended: false },
      );
      await wb.waitForWebview<boolean>(`(d) => d.querySelector('[data-tab="comments"] .tab-count')?.textContent === '1'`, 'one comment to decide', 3_000);

      await wb.clickWebview(`${qSel(q.id)} button`, { text: 'See it in Comments' });
      await wb.waitForWebview<boolean>(`(d) => d.querySelector('[data-tab="comments"]')?.getAttribute('aria-selected') === 'true'`, 'the Comments tab', 3_000);
      const view = await waitFor(() => commentView(wb, c.id), 'the comment card');
      assert.equal(view.status, 'draft');
      assert.equal(view.body, flat(seed.body));
      assert.match(view.origin, /^From your call on: /);
      await shot('review-comment-drafted');
    });

    const amended = 'Keep half-up as the default and add roundHalfEven for the callers that want it: checkout-web, payouts-service and reporting all call roundToCents.';

    it('Amend changes the comment text', async () => {
      await wb.clickWebview(keySel(`c:${commentId}:amend`));
      const box = draftSel(`amend:${commentId}`);
      assert.equal(await typeInto(wb, box, amended, { replace: true }), amended);
      await wb.clickWebview(keySel(`c:${commentId}:save`));
      const s = await snapshotWhere((x) => x.comments[0]?.body === amended, 'the amended body');
      assert.equal(s.comments[0].amended, true);
      const view = await waitFor(async () => {
        const v = await commentView(wb, commentId);
        return v?.body === amended ? v : undefined;
      }, 'the card to show the new text');
      assert.ok(view.tags.includes('Edited'), `tags: ${view.tags.join(', ')}`);
    });

    it('Accept marks it accepted, and Undo makes it a draft again', async () => {
      await wb.clickWebview(keySel(`c:${commentId}:accept`));
      await snapshotWhere((x) => x.comments[0]?.status === 'accepted', 'the comment accepted');
      await waitFor(async () => (await commentView(wb, commentId))?.status === 'accepted', 'the card drawn as accepted');
      assert.match(await textOf(wb, `${cSel(commentId)} .ccard-status`), /^✓ Accepted Will be posted\./);

      await wb.clickWebview(keySel(`c:${commentId}:undo`));
      await snapshotWhere((x) => x.comments[0]?.status === 'draft', 'the comment back to draft');
      await waitFor(async () => (await commentView(wb, commentId))?.status === 'draft', 'the card drawn as a draft');
    });

    const note = 'The README still says amounts round half-up; worth updating with this change.';

    it('Add a note turns free text into a draft comment', async () => {
      assert.equal(await typeInto(wb, draftSel('note'), note), note);
      await wb.clickWebview(keySel('note:add'));
      const s = await snapshotWhere((x) => x.comments.some((c) => c.origin.kind === 'note'), 'the note as a comment');
      const c = s.comments.find((x) => x.origin.kind === 'note')!;
      // Nothing is selected, so it's a general comment.
      assert.deepEqual({ body: c.body, status: c.status, severity: c.severity, nodeId: c.nodeId, file: c.file }, { body: note, status: 'draft', severity: 'suggestion', nodeId: undefined, file: undefined });
      const view = await waitFor(() => commentView(wb, c.id), 'the note card');
      assert.equal(view.origin, 'Your note');
      // Sent, so the box empties.
      await wb.waitForWebview<boolean>(`(d, w, f, sel) => d.querySelector(sel)?.value === ''`, 'the note box to empty', 3_000, draftSel('note'));
    });

    it('the sample has no agent: Discuss and "Draft comments with agent" are disabled and say why', async () => {
      const api = await filos();
      const reason = /^This review has no agent: it is the hand-written sample\./;
      const before = (await snapshot()).comments;

      await wb.clickWebview(keySel('draft:agent'));
      assert.ok(await isDisabled(wb, keySel('draft:agent')));
      assert.match(await textOf(wb, '.agent-box .no-agent-note'), reason);

      await wb.clickWebview(keySel(`c:${commentId}:discuss`));
      const box = draftSel(`thread:${commentId}`);
      await wb.waitForWebview<boolean>(`(d, w, f, sel) => !!d.querySelector(sel)`, 'the discussion box', 3_000, box);
      assert.ok(await isDisabled(wb, keySel(`c:${commentId}:send`)));
      assert.match(await textOf(wb, `${cSel(commentId)} .thread .no-agent-note`), reason);
      await wb.clickWebview(keySel(`c:${commentId}:send`));
      await sleep(300);
      await api.waitForReviewIdle();
      const after = await snapshot();
      assert.deepEqual(after.comments, before, 'nothing was asked of an agent');
      assert.equal(after.draftingPending, undefined);
      await shot('review-no-agent');
      // Close the discussion again.
      await wb.clickWebview(keySel(`c:${commentId}:discuss`));
    });

    it('Export as Markdown puts the accepted comment on the clipboard, and opens it beside the review', async () => {
      const api = await filos();
      await wb.clickWebview(keySel(`c:${commentId}:accept`));
      await snapshotWhere((x) => x.comments[0]?.status === 'accepted', 'the comment accepted');

      // The sample has no PR: Post is disabled and says why.
      assert.equal(await textOf(wb, '.post-box .post-target--none'), SAMPLE_POST_REASON);
      assert.ok(await isDisabled(wb, keySel('post:go')), 'Post should be disabled for the sample');

      await vscode.env.clipboard.writeText('(nothing exported yet)');
      await wb.clickWebview(keySel('post:export'));
      const md = await waitFor(async () => {
        const t = await vscode.env.clipboard.readText();
        return t !== '(nothing exported yet)' ? t : undefined;
      }, 'the export on the clipboard');
      try {
        assert.ok(md.startsWith(`# Review: ${SAMPLE_TITLE}\n`), md.slice(0, 200));
        assert.ok(md.includes('\n## Comments (1)\n'), md);
        assert.ok(md.includes(`\n> ${amended}\n`), 'the accepted comment, block-quoted');
        assert.ok(md.includes('\n## Drafts, not accepted (1)\n'), md);
        assert.ok(md.includes(`\n> ${note}\n`), 'the note, as a draft');
        assert.ok(md.indexOf(amended) < md.indexOf('## Drafts'), 'accepted comments come before drafts');
        assert.equal(api.getLastExport(), md);
        const ed = await waitFor(() => (vscode.window.activeTextEditor?.document.isUntitled ? vscode.window.activeTextEditor : undefined), 'the exported document');
        assert.equal(ed.document.languageId, 'markdown');
        assert.equal(ed.document.getText(), md);
        assert.equal(ed.viewColumn, vscode.ViewColumn.Two, 'beside the review panel');
        await shot('review-export');
      } finally {
        await closeExport();
        // Its "on the clipboard" toast sits over the bottom of the pane.
        await clearNotifications();
      }
    });

    after(async () => {
      await closeExport();
      if (wb) await openTab(wb, 'summary').catch(() => undefined);
    });
  });

  describe('Review depth', function () {
    let wb: Workbench;

    before(async function () {
      if (!cdpPort()) this.skip();
      wb = await workbench();
      // Continues the sample review above (or starts one when run alone).
      if (!(await filos()).getReviewSnapshot()) await freshReview(wb, 'filos.reviewSample');
      await openTab(wb, 'questions');
    });

    const chooseDepth = async (depth: 'skim' | 'standard' | 'deep') => {
      const open = await wb.evalWebview<boolean>(`(d) => d.querySelector('.depth-menu')?.hidden === false`);
      if (!open) await wb.clickWebview('.depth-button');
      await wb.clickWebview(`label[for="filos-depth-${depth}"]`);
      const s = await snapshotWhere((x) => x.depth.chosen === depth, `depth ${depth}`);
      await wb.waitForWebview<boolean>(`(d, w, f, n) => d.querySelectorAll('#filos-panel-questions [data-question-id]').length === n`, `${s.questions.length} cards`, 5_000, s.questions.length);
      return s;
    };

    it('the depth menu shows each depth with its question count and the proposal', async () => {
      await wb.clickWebview('.depth-button');
      const options = await wb.waitForWebview<string[]>(
        `(d) => d.querySelector('.depth-menu')?.hidden === false && [...d.querySelectorAll('.depth-option')].map((o) => o.textContent.replace(/\\s+/g, ' ').trim())`,
        'the depth menu',
      );
      assert.equal(options.length, 3);
      assert.match(options[0], /^Skim.*4 questions/);
      assert.match(options[1], /^Standard\s*proposed.*12 questions/);
      assert.match(options[2], /^Deep.*14 questions/);
      await shot('review-depth-menu');
    });

    it('Skim asks fewer questions and Deep more; answers are kept across the switch', async () => {
      const standard = (await snapshot()).questions.length;
      const skim = await chooseDepth('skim');
      assert.deepEqual(skim.questions.map((q) => q.id).sort(), idsAt('skim').sort());
      assert.ok(skim.questions.length < standard, `skim ${skim.questions.length} vs standard ${standard}`);
      assert.match(await textOf(wb, '.depth-button'), /^Depth: Skim · proposed: Standard/);

      const deep = await chooseDepth('deep');
      assert.deepEqual(deep.questions.map((q) => q.id).sort(), idsAt('deep').sort());
      assert.ok(deep.questions.length > standard, `deep ${deep.questions.length} vs standard ${standard}`);
      assert.ok(deep.answers['q-multiply-ties']?.done, 'the answer given at standard depth is still there');

      const back = await chooseDepth('standard');
      assert.equal(back.questions.length, standard);
      assert.match(await textOf(wb, '.depth-button'), /^Depth: Standard · proposed/);
      await wb.clickWebview('.depth-menu button', { text: 'Done' });
      await wb.waitForWebview<boolean>(`(d) => d.querySelector('.depth-menu')?.hidden === true`, 'the depth menu to close', 3_000);
    });

    after(async () => {
      if (wb) await openTab(wb, 'summary').catch(() => undefined);
    });
  });

  describe('Agent tasks with the fake claude CLI', function () {
    let wb: Workbench;

    before(async function () {
      if (!cdpPort() || !process.env.FILOS_E2E_FAKE_CLAUDE) this.skip();
      wb = await workbench();
      process.env.FAKE_CLAUDE_MODE = 'ok';
      // The questions task takes a few seconds, so the pane can be seen waiting for it.
      process.env.FAKE_CLAUDE_MODE_QUESTIONS = 'slow';
      process.env.FAKE_CLAUDE_DELAY_MS = '4000';
      await clearNotifications();
    });

    after(async () => {
      delete process.env.FAKE_CLAUDE_MODE_QUESTIONS;
      delete process.env.FAKE_CLAUDE_DELAY_MS;
      await clearNotifications();
      if (wb) await openTab(wb, 'summary').catch(() => undefined);
    });

    it('an agent review writes its questions in the background: first "being written", then the questions', async () => {
      const api = await filos();
      await closeAllEditors();
      await api.resetStoredState();
      const t0 = Date.now();
      await vscode.commands.executeCommand('filos.reviewSampleWithAgent');
      assert.equal(api.getSession()?.source, 'agent');
      const first = await snapshot();
      assert.equal(first.questionsStatus.state, 'loading');
      assert.equal(first.agentAvailable, true);
      assert.deepEqual(first.questions, []);

      await renderedAfter(t0, (r) => r.visibleNodes.length > 0, 20_000);
      await graphSettled(wb);
      await openTab(wb, 'questions');
      const writing = await wb.waitForWebview<string>(`(d) => d.querySelector('#filos-panel-questions .pending-line')?.textContent`, 'the "being written" line', 5_000);
      assert.match(writing, /writing questions/);
      assert.equal(await textOf(wb, '[data-tab="questions"] .tab-count'), '…');
      await shot('agent-questions-loading');

      const s = await snapshotWhere((x) => x.questionsStatus.state === 'ready', 'the agent questions', 30_000);
      assert.deepEqual(s.questions.map((q) => q.id).sort(), idsAt('standard').sort());
      await wb.waitForWebview<boolean>(`(d, w, f, n) => d.querySelectorAll('#filos-panel-questions [data-question-id]').length === n`, 'the question cards', 5_000, s.questions.length);
      delete process.env.FAKE_CLAUDE_MODE_QUESTIONS;
    });

    it('an open answer is graded by the agent: a miss gets a hint back, "half-even" is right', async () => {
      const q = sampleQuestion('q-checkout-web');
      assert.equal(q.choices, undefined, 'fixture changed: q-checkout-web should be an open question');
      const box = draftSel(`answer:${q.id}`);
      const first = 'Nothing changes for checkout-web.';
      assert.equal(await typeInto(wb, box, first), first);
      assert.match(await textOf(wb, `${qSel(q.id)} .cost-note`), /Uses Claude Code/);
      await wb.clickWebview(keySel(`q:${q.id}:submit`));
      let card = await cardIn(wb, q.id, 'retry', '', 20_000);
      assert.equal(card.verdict, 'retry');
      assert.match(card.feedback, /exact tie/, 'the fake asks a question back on a first miss');
      assert.match(card.feedback, /Feedback from Claude Code/);
      await shot('agent-graded-hint');

      const second = 'Ties now round half-even, so its cart totals can differ from the invoices by a cent.';
      assert.equal(await typeInto(wb, box, second), second, 'a fresh answer box after the hint');
      await wb.clickWebview(keySel(`q:${q.id}:submit`));
      card = await cardIn(wb, q.id, 'done', '', 20_000);
      assert.equal(card.verdict, 'correct');
      const s = await snapshot();
      assert.deepEqual(
        s.answers[q.id].attempts.map((a) => [a.text, a.verdict, a.by]),
        [
          [first, 'incorrect', 'agent'],
          [second, 'correct', 'agent'],
        ],
      );
    });

    it('Discuss: the agent replies with a rewrite, and "Use this version" adopts it', async () => {
      await wb.clickWebview(`${qSel('q-round-default')} [data-choice-id="keep-half-up"]`);
      let s = await snapshotWhere((x) => x.comments.length === 1, 'the drafted comment');
      const id = s.comments[0].id;
      await openTab(wb, 'comments');
      await wb.clickWebview(keySel(`c:${id}:discuss`));
      const message = 'Make this shorter and suggest a test the author could add.';
      assert.equal(await typeInto(wb, draftSel(`thread:${id}`), message), message);
      await wb.clickWebview(keySel(`c:${id}:send`));

      s = await snapshotWhere((x) => {
        const c = x.comments.find((y) => y.id === id);
        return !!c && !c.threadPending && c.thread.length === 2;
      }, 'the agent reply', 20_000);
      const c = s.comments.find((y) => y.id === id)!;
      assert.deepEqual(c.thread[0], { role: 'user', text: message });
      assert.equal(c.thread[1].role, 'agent');
      const proposal = c.thread[1].proposal;
      assert.ok(proposal, 'the fake proposes a rewrite');
      await wb.waitForWebview<boolean>(`(d, w, f, sel) => !!d.querySelector(sel + ' .proposal')`, 'the proposal in the thread', 5_000, cSel(id));
      await shot('agent-thread-proposal');

      await wb.clickWebview(keySel(`c:${id}:adopt:1`));
      s = await snapshotWhere((x) => x.comments.find((y) => y.id === id)?.body === proposal, 'the proposal adopted');
      assert.equal(s.comments.find((y) => y.id === id)!.amended, true);
      await wb.waitForWebview<boolean>(
        `(d, w, f, sel, body) => d.querySelector(sel + ' .ctag--inuse')?.textContent === '✓ In use' && d.querySelector(sel + ' .ccard-body')?.textContent === body`,
        'the card to show the adopted text',
        5_000,
        cSel(id),
        proposal,
      );
    });

    it('"Draft comments with agent" adds the comment the agent drafted', async () => {
      const before = (await snapshot()).comments.length;
      await wb.clickWebview(keySel('draft:agent'));
      const s = await snapshotWhere((x) => !x.draftingPending && x.comments.length > before, 'the agent draft', 20_000);
      const added = s.comments.filter((c) => c.origin.kind === 'agent');
      assert.equal(added.length, 1);
      assert.equal(added[0].status, 'draft');
      assert.equal(added[0].severity, 'suggestion');
      const view = await waitFor(() => commentView(wb, added[0].id), 'the agent draft card');
      assert.equal(view.origin, 'Drafted by Claude Code from your answers');
      await shot('agent-drafted');
    });
  });

  describe('Posting to GitHub with the fake gh', function () {
    let wb: Workbench;
    let record: string;
    let workspace: string;
    const calls = (): GhCall[] => (existsSync(record) ? readFileSync(record, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as GhCall) : []);
    const apiCalls = () => calls().filter((c) => c.argv[0] === 'api');

    before(async function () {
      const ws = process.env.FILOS_E2E_WORKSPACE;
      if (!cdpPort() || !ws || !process.env.FILOS_E2E_FAKE_GH || !process.env.FILOS_E2E_RUN) this.skip();
      workspace = realpathSync(ws);
      assert.equal(vscode.workspace.getConfiguration('filos').get('gh.path'), process.env.FILOS_E2E_FAKE_GH, 'filos.gh.path should point at the fake gh');
      wb = await workbench();
      record = join(process.env.FILOS_E2E_RUN!, 'gh-calls.jsonl');
      rmSync(record, { force: true });
      process.env.FAKE_GH_RECORD = record;
      process.env.FAKE_GH_MODE = 'ok';
      process.env.FAKE_CLAUDE_MODE = 'ok';
    });

    after(async () => {
      (await filos()).setConfirmAnswer(undefined);
      delete process.env.FAKE_GH_RECORD;
      process.env.FAKE_GH_MODE = 'ok';
      await clearNotifications();
      if (wb) await openTab(wb, 'summary').catch(() => undefined);
    });

    it("a branch review finds its pull request with gh; Post stays disabled until a comment is accepted", async () => {
      const api = await filos();
      await freshReview(wb, 'filos.reviewCurrentBranch');
      await api.waitForReviewIdle();
      const s = await snapshotWhere((x) => x.post.target.kind === 'github', 'the pull request', 15_000);
      assert.deepEqual(s.post, { target: { kind: 'github', repo: 'acme/ledger', number: 42, url: 'https://github.com/acme/ledger/pull/42' }, status: 'idle' });
      const views = calls().filter((c) => c.argv[0] === 'pr');
      assert.equal(views.length, 1, 'one lookup when the review starts');
      assert.deepEqual(views[0].argv, ['pr', 'view', '--json', 'number,url,headRefOid,baseRefName,state,headRefName']);
      assert.equal(views[0].cwd, workspace);

      await openTab(wb, 'comments');
      assert.match(await textOf(wb, '.post-box .post-target'), /^To pull request #42 in acme\/ledger/);
      const post = keySel('post:go');
      assert.equal(await textOf(wb, post), 'Post 0 accepted comments');
      assert.ok(await isDisabled(wb, post), 'Post should be disabled with nothing accepted');
      // Clicking it anyway does nothing: no confirmation, no gh call.
      await wb.clickWebview(post);
      await sleep(500);
      await api.waitForReviewIdle();
      assert.equal(api.getLastConfirmation(), undefined);
      assert.equal(calls().length, 1);
      await shot('post-disabled');
    });

    it('Post asks for confirmation naming the PR; cancel sends nothing, confirm sends one review with the comment inline', async () => {
      const api = await filos();
      await openTab(wb, 'questions');
      await wb.clickWebview(`${qSel('q-round-default')} [data-choice-id="keep-half-up"]`);
      let s = await snapshotWhere((x) => x.comments.length === 1, 'the drafted comment');
      const c = s.comments[0];
      assert.deepEqual([c.file, c.line], ['src/money/round.ts', 18], 'fixture changed: the comment should sit on a changed line');
      await openTab(wb, 'comments');
      await wb.clickWebview(keySel(`c:${c.id}:accept`));
      await snapshotWhere((x) => x.comments[0]?.status === 'accepted', 'the comment accepted');
      const post = keySel('post:go');
      await wb.waitForWebview<boolean>(
        `(d, w, f, sel) => { const b = d.querySelector(sel); return !!b && b.getAttribute('aria-disabled') !== 'true' && b.textContent === 'Post 1 accepted comment'; }`,
        'Post to be enabled',
        5_000,
        post,
      );

      // Cancel at the confirmation: nothing is sent, and the post goes back to idle.
      api.setConfirmAnswer(false);
      await wb.clickWebview(post);
      await waitFor(() => api.getLastConfirmation(), 'the confirmation');
      await api.waitForReviewIdle();
      s = await snapshot();
      assert.equal(s.post.status, 'idle');
      assert.deepEqual(api.getLastConfirmation(), {
        message: 'Post your review to acme/ledger#42?',
        detail:
          '1 comment inline on changed lines.\n\nThe review is public: anyone who can see the pull request can read it, and GitHub notifies its author. It is posted as you, through the GitHub CLI.',
      });
      assert.equal(apiCalls().length, 0, 'nothing posted after cancelling');

      // Confirm: one review, the comment inline on its line, on the PR's head commit.
      api.setConfirmAnswer(true);
      await wb.clickWebview(post);
      s = await snapshotWhere((x) => x.post.status === 'posted', 'the review posted', 15_000);
      assert.equal(s.post.url, 'https://github.com/acme/ledger/pull/42#pullrequestreview-1001');
      const sent = apiCalls();
      assert.equal(sent.length, 1);
      assert.deepEqual(sent[0].argv, ['api', '-X', 'POST', 'repos/acme/ledger/pulls/42/reviews', '--input', '-']);
      assert.equal(sent[0].cwd, workspace);
      const payload = JSON.parse(sent[0].stdin ?? '{}') as { event: string; body: string; commit_id: string; comments: { path: string; line: number; side: string; body: string }[] };
      const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: workspace, encoding: 'utf8' }).trim();
      assert.equal(payload.event, 'COMMENT');
      assert.equal(payload.commit_id, head);
      assert.equal(payload.comments.length, 1);
      const [inline] = payload.comments;
      assert.deepEqual({ path: inline.path, line: inline.line, side: inline.side }, { path: 'src/money/round.ts', line: 18, side: 'RIGHT' });
      assert.equal(inline.body, `**${SEVERITY_LABEL[c.severity]}:** ${c.body.trim()}`);
      assert.deepEqual(api.getLastPost()?.payload, payload);
      assert.equal(s.comments[0].posted, true);

      // The pane says so, and there is nothing left to post.
      await wb.waitForWebview<boolean>(`(d) => (d.querySelector('.post-box .notice--ok')?.textContent ?? '').includes('#pullrequestreview-1001')`, 'the posted notice', 5_000);
      assert.equal(await textOf(wb, post), 'Nothing new to post');
      assert.ok(await isDisabled(wb, post));
      assert.ok((await commentView(wb, c.id))?.tags.includes('Posted'));
      await shot('post-posted');
      api.setConfirmAnswer(undefined);
      await clearNotifications();
    });

    it('not logged in to gh: there is no post target, and the pane says why', async () => {
      const api = await filos();
      process.env.FAKE_GH_MODE = 'auth';
      try {
        const t0 = Date.now();
        await vscode.commands.executeCommand('filos.reviewCurrentBranch');
        await renderedAfter(t0, (r) => r.visibleNodes.length > 0, 20_000);
        await api.waitForReviewIdle();
        const reason = 'The GitHub CLI is not logged in. Run "gh auth login" in a terminal, then try again.';
        const s = await snapshotWhere((x) => x.post.target.kind === 'none' && x.post.target.reason === reason, 'no post target', 15_000);
        assert.equal(s.post.status, 'idle');
        await openTab(wb, 'comments');
        await wb.waitForWebview<boolean>(`(d, w, f, want) => d.querySelector('.post-box .post-target--none')?.textContent === want`, 'the reason in the pane', 5_000, reason);
        assert.ok(await isDisabled(wb, keySel('post:go')));
        await shot('post-not-logged-in');
      } finally {
        process.env.FAKE_GH_MODE = 'ok';
      }
    });
  });
}

/** Closes the untitled Export document without saving (a save prompt would block the run). */
async function closeExport(): Promise<void> {
  for (const doc of vscode.workspace.textDocuments.filter((d) => d.isUntitled && d.isDirty)) {
    await vscode.window.showTextDocument(doc);
    await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
  }
}

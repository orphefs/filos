// "Filos: Review Pull Request…" end to end in real VS Code, offline: pointing Filos at a GitHub pull
// request through the picker (real key presses into VS Code's quick pick) and through the command's
// argument, the loading steps as the webview draws them, the comprehension pass, questions,
// grading, a thread and drafting by the fake `claude` CLI, and posting through the fake `gh`.
//
// The fake gh answers from a local stand-in for GitHub built here with makeRemote: a bare repository
// made from fixtures/sample-repo (base on main, head on refs/pull/9/head) that `gh repo clone` clones
// over file://, and the pull request as `gh pr view --json` gives it (FAKE_GH_PR_JSON). The fake
// claude returns fixtures/sample-graph.json and fixtures/sample-questions.json (set by runE2E), which
// are valid for that head. Both fakes read process.env when they are spawned, so a test switches
// their modes by setting it here. As in review.test.ts, the posting (and deleting) confirmation is
// answered through the test API: a modal would block the run and is out of DevTools' reach.

import * as assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import * as vscode from 'vscode';
import { SEVERITY_LABEL } from '../../src/review/github';
import { makeRemote, PR_HEAD_BRANCH, PR_TITLE, type FakeRemote } from '../fixtures/fake-gh/makeRemote';
import type { Workbench } from './cdp';
import { codeShown, graphSettled } from './clicks.test';
import { cdpPort, editorFor, extensionPath, filos, nodeSel, renderedAfter, shot, sleep, waitFor, workbench } from './helpers';
import { cardIn, clearNotifications, closeAllEditors, cSel, draftSel, idsAt, isDisabled, keySel, openTab, qSel, sampleQuestion, snapshot, snapshotWhere, textOf, typeInto } from './pane';

const PR_URL = 'https://github.com/acme/ledger/pull/9';
const PR_LABEL = 'acme/ledger#9';
const STEP_LABELS = ['Find the pull request', 'Get the code', 'Claude Code reads the change', 'Claude Code writes questions'];
const GH_NOT_LOGGED_IN = 'The GitHub CLI is not logged in to github.com. Log in with "gh auth login", then retry.';

interface GhCall {
  argv: string[];
  cwd: string;
  mode: string;
  stdin?: string;
  ghHost?: string;
}

export interface StepView {
  state: string;
  label: string;
  detail: string;
}

/** The loading or error view with steps, as the webview draws it. */
export interface StatusView {
  kind: 'loading' | 'error';
  message: string;
  detail: string;
  steps: StepView[];
  actions: string[];
}

const READ_STATUS = `(d) => {
  const host = d.querySelector('.status-host');
  if (!host || host.hidden) return null;
  const box = host.querySelector('.status--steps');
  if (!box) return null;
  const t = (e) => (e && !e.hidden ? e.textContent : '').replace(/\\s+/g, ' ').trim();
  return {
    kind: box.classList.contains('status--error') ? 'error' : 'loading',
    message: t(box.querySelector('.status-message')),
    detail: t(box.querySelector('.status-detail')),
    steps: [...box.querySelectorAll('li.lstep')].map((li) => ({ state: li.dataset.state || '', label: t(li.querySelector('.lstep-label')), detail: t(li.querySelector('.lstep-detail')) })),
    actions: [...box.querySelectorAll('button[data-action]')].map((b) => b.dataset.action),
  };
}`;

export const readStatus = (wb: Workbench) => wb.evalWebview<StatusView | null>(READ_STATUS);

/**
 * Reads the steps view from the webview every few tens of milliseconds while a review starts,
 * keeping each distinct view, so a test can check what was shown and in which order.
 */
export class StatusRecorder {
  readonly seen: StatusView[] = [];
  private stopped = false;
  private readonly loop: Promise<void>;

  constructor(
    private readonly wb: Workbench,
    /** Called once per distinct view, e.g. to take a screenshot of one. */
    private readonly onView?: (v: StatusView) => Promise<void>,
  ) {
    this.loop = this.run();
  }

  private async run(): Promise<void> {
    while (!this.stopped) {
      try {
        const v = await readStatus(this.wb);
        const last = this.seen[this.seen.length - 1];
        if (v && JSON.stringify(v) !== JSON.stringify(last)) {
          this.seen.push(v);
          await this.onView?.(v);
        }
      } catch {
        // no Filos webview on screen yet
      }
      await sleep(40);
    }
  }

  async stop(): Promise<StatusView[]> {
    this.stopped = true;
    await this.loop;
    return this.seen;
  }
}

export const RANK: Record<string, number> = { pending: 0, active: 1, done: 2 };

/** One line per view, for assertion messages. */
export const describeViews = (views: StatusView[]) => views.map((v) => `${v.kind} "${v.message}" [${v.steps.map((s) => `${s.state}${s.detail ? `(${s.detail})` : ''}`).join(', ')}]`).join('\n  ');

/** VS Code's quick input (picker or input box) as drawn, or null while it is hidden. */
export interface QuickInputView {
  title: string;
  value: string;
  placeholder: string;
  /** The prompt, or a validation message. */
  message: string;
  inputFocused: boolean;
  rows: { text: string; focused: boolean }[];
  input: { x: number; y: number } | null;
}

const READ_QUICK_INPUT = `(() => {
  const w = document.querySelector('.quick-input-widget');
  if (!w || getComputedStyle(w).display === 'none') return null;
  const input = w.querySelector('.quick-input-box input');
  const r = input ? input.getBoundingClientRect() : null;
  const visible = (e) => e.offsetParent !== null;
  return {
    title: (w.querySelector('.quick-input-title')?.textContent ?? '').trim(),
    value: input ? input.value : '',
    placeholder: input ? input.placeholder || input.getAttribute('aria-label') || '' : '',
    message: (w.querySelector('.quick-input-message')?.textContent ?? '').trim(),
    inputFocused: !!input && document.activeElement === input,
    rows: [...w.querySelectorAll('.quick-input-list .monaco-list-row')].filter(visible).map((row) => ({ text: row.textContent.replace(/\\s+/g, ' ').trim(), focused: row.classList.contains('focused') })),
    input: r && r.width ? { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) } : null,
  };
})()`;

export const quickInput = (wb: Workbench) => wb.evalPage<QuickInputView | null>(READ_QUICK_INPUT);

/** Waits for the quick input to match, and makes sure its text box has keyboard focus (clicking it if not). */
export async function quickInputWhere(wb: Workbench, pred: (q: QuickInputView) => boolean, what: string, timeoutMs = 10_000): Promise<QuickInputView> {
  let last: QuickInputView | null = null;
  const q = await waitFor(async () => {
    last = await quickInput(wb);
    return last && pred(last) ? last : undefined;
  }, what, timeoutMs).catch((e: unknown) => {
    throw new Error(`${e instanceof Error ? e.message : String(e)}; the quick input showed ${JSON.stringify(last)}`);
  });
  if (!q.inputFocused && q.input) {
    await wb.click(q.input);
    await waitFor(async () => (await quickInput(wb))?.inputFocused, 'the quick input to have focus', 3_000);
  }
  return q;
}

/** ArrowDown until the highlighted row is the one wanted (separators are skipped by VS Code). */
export async function arrowDownTo(wb: Workbench, rowText: RegExp): Promise<void> {
  for (let i = 0; i < 6; i++) {
    const q = await quickInput(wb);
    if (q?.rows.some((r) => r.focused && rowText.test(r.text))) return;
    await wb.press('ArrowDown');
    await sleep(120);
  }
  const q = await quickInput(wb);
  throw new Error(`could not highlight ${rowText} in the picker; rows: ${JSON.stringify(q?.rows)}`);
}

function gitIn(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['--no-optional-locks', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

export function registerPullRequestTests(): void {
  describe('Review Pull Request (fake gh remote, fake claude)', function () {
    let wb: Workbench;
    let fake: FakeRemote;
    let record: string;
    let workspace: string;
    /** <globalStorage>/prs, where the clone and worktrees must go. */
    let prsRoot: string;
    let worktree: string;
    let cloneDir: string;
    /** The workspace before this suite ran, to show afterwards that nothing in it changed. */
    let workspaceBefore: { head: string; refs: string; status: string; worktrees: string };
    let addedRemote = false;

    const calls = (): GhCall[] => (existsSync(record) ? readFileSync(record, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as GhCall) : []);
    const clones = () => calls().filter((c) => c.argv[0] === 'repo' && c.argv[1] === 'clone');
    const views = () => calls().filter((c) => c.argv[0] === 'pr' && c.argv[1] === 'view');

    const workspaceNow = () => ({
      head: gitIn(workspace, 'rev-parse', '--abbrev-ref', 'HEAD'),
      refs: gitIn(workspace, 'for-each-ref', '--format=%(refname) %(objectname)'),
      status: gitIn(workspace, 'status', '--porcelain'),
      worktrees: gitIn(workspace, 'worktree', 'list', '--porcelain'),
    });

    /**
     * Runs a review that should load, and waits until the graph is drawn and settled. A click (Retry,
     * Re-run) returns before the host acts on it, and the review before it was loaded too: so first
     * wait for this run's lookup with gh, made only once the host has replaced the session.
     */
    async function reviewLoads(start: () => Thenable<unknown> | Promise<unknown>, what: string): Promise<void> {
      const api = await filos();
      const mark = calls().length;
      const t0 = Date.now();
      await start();
      await waitFor(() => views().length > 0 && calls().slice(mark).some((c) => c.argv[0] === 'pr' && c.argv[1] === 'view'), `${what} to look the pull request up`, 15_000);
      await waitFor(() => {
        const s = api.getSession();
        return s?.status.kind === 'loaded' && s.source === 'agent' && s.target.kind === 'pr' ? s : undefined;
      }, `${what} to load`, 30_000);
      await renderedAfter(t0, (r) => r.visibleNodes.length > 0, 20_000);
      await graphSettled(wb);
    }

    before(async function () {
      const run = process.env.FILOS_E2E_RUN;
      const ws = process.env.FILOS_E2E_WORKSPACE;
      if (!cdpPort() || !run || !ws || !process.env.FILOS_E2E_FAKE_GH || !process.env.FILOS_E2E_FAKE_CLAUDE) this.skip();
      this.timeout(60_000);
      assert.equal(vscode.workspace.getConfiguration('filos').get('gh.path'), process.env.FILOS_E2E_FAKE_GH, 'filos.gh.path should point at the fake gh');
      assert.equal(vscode.workspace.getConfiguration('filos').get('claude.path'), process.env.FILOS_E2E_FAKE_CLAUDE, 'filos.claude.path should point at the fake claude');
      wb = await workbench();
      workspace = realpathSync(ws);

      fake = makeRemote(join(run, 'pr-remote'), { number: 9, sample: join(extensionPath(), 'fixtures', 'sample-repo') });
      process.env.FAKE_GH_REMOTE = fake.remote;
      process.env.FAKE_GH_PR_JSON = fake.prFile;
      record = join(run, 'gh-calls-pr.jsonl');
      rmSync(record, { force: true });
      process.env.FAKE_GH_RECORD = record;
      process.env.FAKE_GH_MODE = 'ok';
      // A current gh, which knows baseRefOid; the older-gh retry has its own unit test.
      process.env.FAKE_GH_EXTRA_FIELDS = 'baseRefOid';
      process.env.FAKE_CLAUDE_MODE = 'ok';

      // The picker lists the workspace repository's pull requests, which needs a repository with a
      // remote (gh reads it). The test workspace (runE2E's temp dir) gets one for this suite only.
      if (!gitIn(workspace, 'remote')) {
        execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/acme/ledger.git'], { cwd: workspace, stdio: 'pipe' });
        addedRemote = true;
      }
      workspaceBefore = workspaceNow();

      // Filos's global storage in runE2E's profile (--user-data-dir).
      prsRoot = join(run, 'user-data', 'User', 'globalStorage', 'orphefs.filos', 'prs');
      rmSync(prsRoot, { recursive: true, force: true });
      cloneDir = join(prsRoot, 'github.com', 'acme', 'ledger', 'repo');
      worktree = join(prsRoot, 'github.com', 'acme', 'ledger', 'worktrees', `pr-9-${fake.headOid.slice(0, 12)}`);

      const api = await filos();
      await clearNotifications();
      await closeAllEditors();
      await api.resetStoredState();
    });

    after(async () => {
      for (const k of ['FAKE_GH_EXTRA_FIELDS', 'FAKE_GH_REMOTE', 'FAKE_GH_PR_JSON', 'FAKE_GH_RECORD', 'FAKE_GH_DELAY_MS', 'FAKE_CLAUDE_DELAY_MS', 'FAKE_CLAUDE_RECORD', 'FAKE_CLAUDE_MODE_QUESTIONS', 'FAKE_CLAUDE_MODE_EVALUATE', 'FAKE_CLAUDE_MODE_THREAD', 'FAKE_CLAUDE_MODE_DRAFTCOMMENTS']) {
        delete process.env[k];
      }
      process.env.FAKE_GH_MODE = 'ok';
      process.env.FAKE_CLAUDE_MODE = 'ok';
      if (addedRemote) execFileSync('git', ['remote', 'remove', 'origin'], { cwd: workspace, stdio: 'pipe' });
      await vscode.commands.executeCommand('workbench.action.closeQuickOpen');
      (await filos()).setConfirmAnswer(undefined);
      await clearNotifications();
    });

    it('picked with the keyboard: the steps appear and advance, and the graph loads with the PR header', async function () {
      this.timeout(90_000);
      const api = await filos();
      // Slow enough that every step stays on screen for a while: each gh call takes 2 s and the
      // comprehension pass 2.5 s. The questions task runs at full speed.
      process.env.FAKE_GH_MODE = 'slow';
      process.env.FAKE_GH_DELAY_MS = '2000';
      process.env.FAKE_CLAUDE_MODE = 'slow';
      process.env.FAKE_CLAUDE_DELAY_MS = '2500';
      process.env.FAKE_CLAUDE_MODE_QUESTIONS = 'ok';
      // What the comprehension pass is sent: the fake writes it on start. Cleared once read, so the
      // questions task that follows doesn't overwrite it.
      const claudeRecord = join(process.env.FILOS_E2E_RUN!, 'claude-comprehend.json');
      rmSync(claudeRecord, { force: true });
      process.env.FAKE_CLAUDE_RECORD = claudeRecord;
      const sent = waitFor(
        () => {
          const r = existsSync(claudeRecord) ? (JSON.parse(readFileSync(claudeRecord, 'utf8')) as { task: string; cwd: string; prompt: string }) : undefined;
          return r?.task === 'comprehend' ? r : undefined;
        },
        'the comprehension pass to start',
        60_000,
      ).finally(() => delete process.env.FAKE_CLAUDE_RECORD);

      const t0 = Date.now();
      let shotTaken = false;
      const recorder = new StatusRecorder(wb, async (v) => {
        if (shotTaken || v.steps[2]?.state !== 'active') return;
        shotTaken = true;
        await shot('pr-steps');
      });
      let settled = false;
      const run = Promise.resolve(vscode.commands.executeCommand('filos.reviewPullRequest')).finally(() => (settled = true));
      try {
        // The picker opens at once and lists the workspace repository's open pull requests once gh answers.
        const picker = await quickInputWhere(wb, (q) => q.rows.some((r) => /#9 Switch to banker's rounding/.test(r.text)), 'the picker to list #9', 15_000);
        assert.match(picker.title, /Filos: Review Pull Request/);
        assert.match(picker.rows[0].text, /Enter a pull request URL or number/, `rows: ${JSON.stringify(picker.rows)}`);
        const row = picker.rows.find((r) => /#9 /.test(r.text))!;
        assert.match(row.text, /by dana/);
        assert.match(row.text, new RegExp(`${PR_HEAD_BRANCH} → main`));
        await shot('pr-picker');
        await arrowDownTo(wb, /#9 Switch to banker's rounding/);
        await wb.press('Enter');
        await waitFor(async () => (await quickInput(wb)) === null, 'the picker to close', 5_000);
        await run;
      } finally {
        if (!settled) await vscode.commands.executeCommand('workbench.action.closeQuickOpen');
        await recorder.stop().catch(() => undefined);
      }
      const seen = recorder.seen;
      process.env.FAKE_GH_MODE = 'ok';
      process.env.FAKE_CLAUDE_MODE = 'ok';
      delete process.env.FAKE_CLAUDE_MODE_QUESTIONS;

      // The steps, as drawn: always the same four, and no step ever went back.
      const trail = `\n  ${describeViews(seen)}`;
      assert.ok(seen.length >= 3, `too few step views seen:${trail}`);
      for (const v of seen) {
        assert.equal(v.kind, 'loading', `no error expected:${trail}`);
        assert.deepEqual(v.steps.map((s) => s.label), STEP_LABELS);
      }
      for (let i = 0; i < STEP_LABELS.length; i++) {
        const ranks = seen.map((v) => RANK[v.steps[i].state] ?? -1);
        assert.ok(ranks.every((r, k) => r >= 0 && (k === 0 || r >= ranks[k - 1])), `step ${i + 1} went backwards or failed:${trail}`);
      }
      const finding = seen.find((v) => v.steps[0].state === 'active');
      assert.ok(finding, `"Find the pull request" was never shown running:${trail}`);
      assert.equal(finding.message, `Reviewing ${PR_LABEL}`);
      assert.equal(finding.steps[0].detail, PR_LABEL);
      assert.deepEqual(finding.steps.slice(1).map((s) => s.state), ['pending', 'pending', 'pending']);

      const cloning = seen.find((v) => v.steps[1].state === 'active' && v.steps[1].detail === 'cloning acme/ledger');
      assert.ok(cloning, `"Get the code" was never shown cloning:${trail}`);
      const pr = fake.pr as { changedFiles: number; additions: number; deletions: number };
      assert.equal(cloning.steps[0].state, 'done');
      assert.equal(cloning.steps[0].detail, `#9 · ${pr.changedFiles} files · +${pr.additions} −${pr.deletions}`);
      assert.equal(cloning.message, PR_TITLE);
      assert.equal(cloning.detail, `${PR_LABEL} · ${PR_HEAD_BRANCH} → main`);

      const reading = seen.find((v) => v.steps[2].state === 'active');
      assert.ok(reading, `"Claude Code reads the change" was never shown running:${trail}`);
      assert.deepEqual(reading.steps.map((s) => s.state), ['done', 'done', 'active', 'pending']);
      assert.equal(reading.steps[1].detail, `${fake.headOid.slice(0, 7)} · cloned`);

      // The comprehension pass ran in the PR's checkout and was given the author's description,
      // fenced, without its HTML comments.
      const comprehend = await sent;
      assert.equal(comprehend.cwd, realpathSync(worktree));
      assert.match(comprehend.prompt, /-----BEGIN PR DESCRIPTION [0-9a-f]+-----\nRounding now goes to the nearest even cent \(banker's rounding\), and invoices can carry a discount\.\n-----END PR DESCRIPTION [0-9a-f]+-----/);
      assert.ok(!comprehend.prompt.includes('PR template'), 'HTML comments in the description are stripped');
      assert.match(comprehend.prompt, new RegExp(`Head: ${PR_HEAD_BRANCH}`));
      // The PR adds .filos/dependency-index.json; the index comes from where it branched off (none there).
      assert.ok(comprehend.prompt.includes('No dependency index is available'), "the PR's own index is not used");
      assert.ok(!comprehend.prompt.includes('DEPENDENCY INDEX'));

      // The review: an agent graph of pull request acme/ledger#9, its code in Filos's storage.
      const s = api.getSession();
      assert.ok(s);
      assert.deepEqual(s.status, { kind: 'loaded' });
      assert.equal(s.source, 'agent');
      assert.deepEqual(s.target, { kind: 'pr', repoRoot: realpathSync(worktree), base: 'main', head: PR_HEAD_BRANCH, prTitle: PR_TITLE, pr: { url: PR_URL, host: 'github.com', owner: 'acme', repo: 'ledger', number: 9 } });
      assert.equal(s.key, `pr\u0000${PR_URL}`);
      assert.ok(s.warnings.some((w) => /^This pull request changes \.filos\/dependency-index\.json, the dependency index\. Filos used the index as it was where the pull request branched off/.test(w)), s.warnings.join('\n'));
      assert.equal(api.getPanel()?.title, `Filos: ${PR_TITLE}`);
      await renderedAfter(t0, (r) => r.visibleNodes.length > 0, 20_000);
      await graphSettled(wb);
      const header = await wb.evalWebview<{ ref: string; branch: string; author: string; url: string; badge: string }>(
        `(d) => { const t = (s) => (d.querySelector(s)?.textContent ?? '').replace(/\\s+/g, ' ').trim(); return { ref: t('.pr-meta .pr-ref'), branch: t('.pr-meta .branch'), author: t('.pr-meta .author'), url: d.querySelector('.pr-url')?.hidden ? '' : t('.pr-url'), badge: t('.source-badge') }; }`,
      );
      assert.equal(header.ref, PR_LABEL);
      assert.equal(header.branch, `${PR_HEAD_BRANCH} → main`);
      assert.equal(header.author, 'by dana');
      assert.equal(header.url, PR_URL);
      assert.match(header.badge, /^Generated by claude/);

      // gh: one clone of acme/ledger into Filos's storage; the picker's list and the lookup by URL.
      const cloned = clones();
      assert.equal(cloned.length, 1);
      // The host is named, and GH_HOST set to it: a GH_HOST for another server can't redirect the clone.
      assert.deepEqual(cloned[0].argv.slice(0, 3), ['repo', 'clone', 'github.com/acme/ledger']);
      assert.ok(cloned[0].argv[3].startsWith(join(prsRoot, 'github.com', 'acme', 'ledger', '.clone-')), `cloned into ${cloned[0].argv[3]}`);
      assert.ok(cloned[0].argv.includes('--filter=blob:none'));
      assert.equal(cloned[0].ghHost, 'github.com');
      assert.deepEqual(views().map((c) => c.argv.slice(0, 3)), [['pr', 'view', PR_URL]]);
      assert.equal(realpathSync(views()[0].cwd), realpathSync(prsRoot), 'a URL is looked up from Filos storage, not the workspace');
      assert.equal(gitIn(worktree, 'rev-parse', 'HEAD'), fake.headOid);

      // Questions come from the fake, for the standard depth it proposes.
      const q = await snapshotWhere((x) => x.questionsStatus.state === 'ready', 'the questions', 20_000);
      assert.equal(q.agentAvailable, true);
      assert.deepEqual(q.questions.map((x) => x.id).sort(), idsAt('standard').sort());
      assert.deepEqual(q.post, { target: { kind: 'github', repo: 'acme/ledger', number: 9, url: PR_URL }, status: 'idle' });
      await clearNotifications();
      await shot('pr-loaded');
    });

    it("clicking a node opens its code from the PR's worktree in Filos's storage, read-only and never as a file: URI", async () => {
      await clearNotifications();
      let t = Date.now();
      await wb.clickWebview(nodeSel('invoice'), { avoid: '[data-chevron]' });
      await renderedAfter(t, (x) => x.selected === 'invoice' && x.expanded.includes('invoice'));
      await codeShown('invoice', 'src/invoice/invoice.ts');
      await graphSettled(wb);
      t = Date.now();
      await wb.clickWebview(nodeSel('invoice/applyDiscount'));
      await renderedAfter(t, (x) => x.selected === 'invoice/applyDiscount');
      const snap = await codeShown('invoice/applyDiscount', 'src/invoice/discount.ts');
      assert.ok(snap.foldVerified);
      const ed = editorFor('src/invoice/discount.ts');
      assert.ok(ed);
      // Filos's read-only file system, so no other extension (ESLint loading the PR's node_modules,
      // say) takes the PR's checkout for a project and runs its code.
      const uri = ed.document.uri;
      assert.equal(uri.scheme, 'filos-pr');
      const rel = relative(realpathSync(prsRoot), realpathSync(worktree)).split(sep).join('/');
      assert.equal(uri.path, `/${rel}/src/invoice/discount.ts`, 'the file in the worktree under Filos storage');
      assert.ok(!existsSync(uri.fsPath), "the URI's path is no path on disk: tooling that reads it anyway finds nothing");
      const opened = join(realpathSync(prsRoot), ...uri.path.split('/'));
      assert.ok(opened.startsWith(realpathSync(worktree) + sep), `opened ${opened}, expected a file under ${worktree}`);
      assert.ok(!opened.startsWith(workspace + sep), 'never a file of the workspace');
      assert.ok(!vscode.window.visibleTextEditors.some((e) => e.document.uri.scheme === 'file' && e.document.uri.fsPath.startsWith(realpathSync(prsRoot))), 'no file: editor on the checkout');
      assert.equal(ed.document.getText(), readFileSync(join(extensionPath(), 'fixtures', 'sample-repo', 'head', 'src', 'invoice', 'discount.ts'), 'utf8'), 'the PR head as checked out');
      // Read-only: a file system that takes no writes (the editor shows its files read-only).
      assert.equal(vscode.workspace.fs.isWritableFileSystem('filos-pr'), false);
      await assert.rejects(Promise.resolve(vscode.workspace.fs.writeFile(uri, Buffer.from('changed'))), 'the file system refuses writes');
      assert.equal(readFileSync(opened, 'utf8'), ed.document.getText(), 'unchanged on disk');
      await shot('pr-code');
    });

    it('the agent grades an open answer: a miss gets a hint back, "half-even" is right', async () => {
      await clearNotifications();
      await openTab(wb, 'questions');
      // The tab shows the selected node's questions first: ask for all of them.
      if ((await textOf(wb, keySel('questions:showAll'))).startsWith('Show all')) await wb.clickWebview(keySel('questions:showAll'));
      const n = idsAt('standard').length;
      await wb.waitForWebview<boolean>(`(d, w, f, n) => d.querySelectorAll('#filos-panel-questions [data-question-id]').length === n`, `all ${n} question cards`, 5_000, n);
      const q = sampleQuestion('q-checkout-web');
      assert.equal(q.choices, undefined, 'fixture changed: q-checkout-web should be an open question');
      const box = draftSel(`answer:${q.id}`);
      const first = 'Nothing changes for checkout-web.';
      assert.equal(await typeInto(wb, box, first), first);
      await wb.clickWebview(keySel(`q:${q.id}:submit`));
      let card = await cardIn(wb, q.id, 'retry', '', 20_000);
      assert.match(card.feedback, /exact tie/);
      assert.match(card.feedback, /Feedback from Claude Code/);

      const second = 'Ties now round half-even, so its cart totals can differ from the invoices by a cent.';
      assert.equal(await typeInto(wb, box, second), second);
      await wb.clickWebview(keySel(`q:${q.id}:submit`));
      card = await cardIn(wb, q.id, 'done', '', 20_000);
      assert.equal(card.verdict, 'correct');
      assert.deepEqual(
        (await snapshot()).answers[q.id].attempts.map((a) => [a.verdict, a.by]),
        [
          ['incorrect', 'agent'],
          ['correct', 'agent'],
        ],
      );
      await shot('pr-graded');
    });

    let commentId = '';

    it('a judgement drafts a comment; a thread with the agent rewrites it; the agent drafts another', async () => {
      await wb.clickWebview(`${qSel('q-round-default')} [data-choice-id="keep-half-up"]`);
      let s = await snapshotWhere((x) => x.comments.length === 1, 'the drafted comment');
      const c = s.comments[0];
      commentId = c.id;
      assert.deepEqual([c.file, c.line, c.status], ['src/money/round.ts', 18, 'draft'], 'fixture changed: the comment should sit on a changed line');

      await openTab(wb, 'comments');
      await wb.clickWebview(keySel(`c:${c.id}:discuss`));
      const message = 'Make this shorter and suggest a test the author could add.';
      assert.equal(await typeInto(wb, draftSel(`thread:${c.id}`), message), message);
      await wb.clickWebview(keySel(`c:${c.id}:send`));
      s = await snapshotWhere((x) => {
        const y = x.comments.find((z) => z.id === c.id);
        return !!y && !y.threadPending && y.thread.length === 2;
      }, 'the agent reply', 20_000);
      const proposal = s.comments.find((z) => z.id === c.id)!.thread[1].proposal;
      assert.ok(proposal, 'the fake proposes a rewrite');
      await wb.clickWebview(keySel(`c:${c.id}:adopt:1`));
      await snapshotWhere((x) => x.comments.find((z) => z.id === c.id)?.body === proposal, 'the proposal adopted');

      const before = (await snapshot()).comments.length;
      await wb.clickWebview(keySel('draft:agent'));
      s = await snapshotWhere((x) => !x.draftingPending && x.comments.length > before, 'the agent draft', 20_000);
      assert.equal(s.comments.filter((z) => z.origin.kind === 'agent').length, 1);
      await shot('pr-comments');
    });

    it('Post names acme/ledger#9; the fake gh gets one review at the PR head with the comment inline', async () => {
      const api = await filos();
      await clearNotifications();
      await wb.clickWebview(keySel(`c:${commentId}:accept`));
      let s = await snapshotWhere((x) => x.comments.find((c) => c.id === commentId)?.status === 'accepted', 'the comment accepted');
      const c = s.comments.find((z) => z.id === commentId)!;
      assert.match(await textOf(wb, '.post-box .post-target'), /^To pull request #9 in acme\/ledger/);
      const post = keySel('post:go');
      await wb.waitForWebview<boolean>(
        `(d, w, f, sel) => { const b = d.querySelector(sel); return !!b && b.getAttribute('aria-disabled') !== 'true' && b.textContent === 'Post 1 accepted comment to acme/ledger#9'; }`,
        'Post to be enabled',
        5_000,
        post,
      );
      const before = calls().length;

      api.setConfirmAnswer(true);
      try {
        await wb.clickWebview(post);
        s = await snapshotWhere((x) => x.post.status === 'posted', 'the review posted', 15_000);
      } finally {
        api.setConfirmAnswer(undefined);
      }
      assert.equal(api.getLastConfirmation()?.message, `Post your review to ${PR_LABEL}?`);
      assert.match(api.getLastConfirmation()?.detail ?? '', /^1 comment inline on changed lines\./);
      assert.equal(s.post.url, `${PR_URL}#pullrequestreview-1001`);

      // Before posting, the pull request is looked up again by its URL; then one review is sent.
      const made = calls().slice(before);
      // The post names its host: a GH_HOST in the environment can't send it to another server.
      assert.deepEqual(made.map((x) => x.argv.slice(0, 3)), [
        ['pr', 'view', PR_URL],
        ['api', '--hostname', 'github.com'],
      ]);
      const sent = made[1];
      assert.deepEqual(sent.argv, ['api', '--hostname', 'github.com', '-X', 'POST', 'repos/acme/ledger/pulls/9/reviews', '--input', '-']);
      assert.equal(realpathSync(sent.cwd), realpathSync(worktree), "gh posts from the PR's checkout, not the workspace");
      const payload = JSON.parse(sent.stdin ?? '{}') as { event: string; commit_id: string; comments: { path: string; line: number; side: string; body: string }[] };
      assert.equal(payload.event, 'COMMENT');
      assert.equal(payload.commit_id, fake.headOid, 'posted against the commit that was reviewed');
      assert.equal(payload.comments.length, 1);
      const [inline] = payload.comments;
      assert.deepEqual({ path: inline.path, line: inline.line, side: inline.side }, { path: 'src/money/round.ts', line: 18, side: 'RIGHT' });
      assert.equal(inline.body, `**${SEVERITY_LABEL[c.severity]}:** ${c.body.trim()}`);
      assert.deepEqual(api.getLastPost()?.payload, payload);
      assert.equal(s.comments.find((z) => z.id === commentId)?.posted, true);

      await wb.waitForWebview<boolean>(`(d) => (d.querySelector('.post-box .notice--ok')?.textContent ?? '').includes('#pullrequestreview-1001')`, 'the posted notice', 5_000);
      assert.equal(await textOf(wb, post), 'Nothing new to post');
      assert.ok(await isDisabled(wb, post));
      await shot('pr-posted');
      await clearNotifications();
    });

    it('gh not logged in: "Find the pull request" fails with steps, Log in again and Retry; Retry reuses the clone and keeps the review', async function () {
      this.timeout(90_000);
      const api = await filos();
      await clearNotifications();
      process.env.FAKE_GH_MODE = 'auth';
      try {
        await vscode.commands.executeCommand('filos.reviewPullRequest', PR_URL);
        const st = api.getSession()?.status;
        assert.ok(st?.kind === 'error', `expected an error, got ${JSON.stringify(st)}`);
        assert.equal(st.message, GH_NOT_LOGGED_IN);
        assert.deepEqual(st.actions, ['login', 'retry']);
        assert.deepEqual(st.steps?.map((x) => x.state), ['failed', 'pending', 'pending', 'pending']);

        const shown = await waitFor(async () => {
          const v = await readStatus(wb);
          return v?.kind === 'error' ? v : undefined;
        }, 'the error view with steps');
        assert.equal(shown.message, GH_NOT_LOGGED_IN);
        assert.deepEqual(shown.steps.map((x) => [x.label, x.state]), STEP_LABELS.map((l, i) => [l, i === 0 ? 'failed' : 'pending']));
        assert.deepEqual(shown.actions, ['login', 'retry']);
        assert.equal(await textOf(wb, '.status--error button[data-action="login"]'), 'Log in again');
        await shot('pr-gh-auth-error');

        // "Log in again" runs gh's own login in a terminal, for the pull request's host.
        await wb.clickWebview('.status--error button[data-action="login"]');
        const terminal = await waitFor(() => vscode.window.terminals.find((t) => t.name === 'Filos: GitHub login'), 'the "Filos: GitHub login" terminal');
        const opts = terminal.creationOptions as vscode.TerminalOptions;
        assert.equal(opts.shellPath, process.env.FILOS_E2E_FAKE_GH);
        assert.deepEqual(opts.shellArgs, ['auth', 'login', '--hostname', 'github.com']);
        terminal.dispose();
        await vscode.commands.executeCommand('workbench.action.closePanel');
        await waitFor(async () => (await readStatus(wb))?.kind === 'error', 'the error view to be back in view', 5_000);
      } finally {
        process.env.FAKE_GH_MODE = 'ok';
      }

      // Logged in again: Retry runs the whole flow, fetching into the clone that is already there.
      await reviewLoads(() => wb.clickWebview('.status--error button[data-action="retry"]'), 'the retried review');
      assert.equal(clones().length, 1, 'no second clone');
      assert.equal(api.getSession()?.target.repoRoot, realpathSync(worktree), 'the same worktree');
      // The review is the pull request's, by its URL: answers, comments and posted marks are back.
      const s = await snapshotWhere((x) => x.questionsStatus.state === 'ready', 'the questions', 20_000);
      assert.equal(s.answers['q-checkout-web']?.done, true);
      assert.equal(s.comments.find((c) => c.id === commentId)?.posted, true);
      // Kept globally, by URL, so the same PR opened from another window (or none) finds it too.
      const stored = api.getStoredKeys();
      assert.ok(stored.global.includes(`filos.review:pr\u0000${PR_URL}`), JSON.stringify(stored.global));
      assert.ok(stored.global.includes(`filos.viewState:pr\u0000${PR_URL}`), JSON.stringify(stored.global));
      assert.ok(!stored.workspace.some((k) => k.includes(PR_URL)), JSON.stringify(stored.workspace));
      await clearNotifications();
    });

    it('the argument form owner/repo#n and Re-run analysis fetch again, still without a second clone', async function () {
      this.timeout(90_000);
      const api = await filos();
      const before = calls().length;
      await reviewLoads(() => vscode.commands.executeCommand('filos.reviewPullRequest', PR_LABEL), 'acme/ledger#9');
      const lookup = calls()
        .slice(before)
        .find((c) => c.argv[0] === 'pr' && c.argv[1] === 'view');
      assert.ok(lookup);
      assert.deepEqual(lookup.argv.slice(0, 5), ['pr', 'view', '9', '--repo', 'acme/ledger']);
      assert.equal(realpathSync(lookup.cwd), realpathSync(prsRoot));
      assert.equal(api.getSession()?.key, `pr\u0000${PR_URL}`);
      await clearNotifications();

      const mark = calls().length;
      await reviewLoads(() => wb.clickWebview('.toolbar button', { text: 'Re-run analysis' }), 'the re-run');
      assert.deepEqual(
        calls()
          .slice(mark)
          .filter((c) => c.argv[0] === 'pr' && c.argv[1] === 'view')
          .map((c) => c.argv.slice(0, 3)),
        [['pr', 'view', PR_URL]],
        'Re-run goes to the pull request by its URL',
      );
      assert.equal(clones().length, 1, 'no second clone');
      await clearNotifications();
    });

    it('"Enter a pull request URL or number…" opens an input box that checks what is typed', async function () {
      this.timeout(60_000);
      const api = await filos();
      let settled = false;
      const run = Promise.resolve(vscode.commands.executeCommand('filos.reviewPullRequest')).finally(() => (settled = true));
      try {
        await quickInputWhere(wb, (q) => q.rows.some((r) => r.focused && /Enter a pull request URL or number/.test(r.text)), 'the picker with "Enter a pull request URL…" highlighted');
        await wb.press('Enter');
        // An empty box (it never reads the clipboard) that says what it takes.
        const box = await quickInputWhere(wb, (q) => !q.rows.length && q.placeholder === 'https://github.com/owner/repo/pull/123', 'the input box');
        assert.equal(box.value, '');
        assert.match(box.title, /Filos: Review Pull Request/);
        assert.match(box.message, /^A pull request URL, owner\/repo#number, or a number in this workspace's repository/);
        // Something that isn't a pull request is refused as it is typed.
        await wb.type('acme/ledger');
        await quickInputWhere(wb, (q) => /^That isn't a pull request\./.test(q.message), 'the validation message');
        // A URL as copied from the browser, on its Files tab: accepted, and reviewed as the pull request.
        await wb.evalPage(`(() => { document.querySelector('.quick-input-widget .quick-input-box input').select(); return true; })()`);
        await wb.type(`${PR_URL}/files`);
        await quickInputWhere(wb, (q) => q.value === `${PR_URL}/files` && !/isn't a pull request/.test(q.message), 'the URL to be accepted');
        await shot('pr-input-box');
        const t0 = Date.now();
        await wb.press('Enter');
        await run;
        await renderedAfter(t0, (r) => r.visibleNodes.length > 0, 20_000);
      } finally {
        if (!settled) await vscode.commands.executeCommand('workbench.action.closeQuickOpen');
      }
      const s = api.getSession();
      assert.equal(s?.status.kind, 'loaded');
      assert.equal(s?.target.pr?.url, PR_URL);
      assert.equal(clones().length, 1);
      await graphSettled(wb);
      await clearNotifications();
    });

    it('the workspace was never touched: same branch, refs, worktrees and changes; gh only listed pull requests there', () => {
      assert.deepEqual(workspaceNow(), workspaceBefore);
      const real = (p: string) => (existsSync(p) ? realpathSync(p) : p);
      const there = calls().filter((c) => real(c.cwd) === workspace);
      assert.ok(there.length > 0, 'the picker lists the workspace repository’s pull requests');
      assert.deepEqual([...new Set(there.map((c) => c.argv.slice(0, 2).join(' ')))], ['pr list']);
      assert.ok(existsSync(join(cloneDir, '.git')), 'the clone is in Filos storage');
    });

    it('Delete Pull Request Checkouts removes the clones and closes the pull request review', async () => {
      const api = await filos();
      assert.ok(existsSync(prsRoot));
      api.setConfirmAnswer(true);
      try {
        await vscode.commands.executeCommand('filos.cleanPullRequestCheckouts');
      } finally {
        api.setConfirmAnswer(undefined);
      }
      assert.ok(!existsSync(prsRoot), 'the storage is gone');
      await waitFor(() => api.getSession() === undefined, 'the review to close');
      await clearNotifications();
    });
  });
}

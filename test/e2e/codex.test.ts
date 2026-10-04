// The Codex CLI as the agent, end to end in real VS Code, offline. filos.provider is set to codex in
// user settings (and back afterwards); filos.codex.path points at the fake codex
// (test/fixtures/fake-codex), which parses `codex exec`'s flags strictly, prints its --json event
// stream and answers like a strict-mode model (nulls for absent fields). runE2E points it at the
// sample graph and questions, as for the fake claude.
//
// Covered here: a pull request reviewed on Codex (steps, the lockdown the CLI was started with, the
// graph, questions, grading, a thread and drafting, all with Codex's name), an expired Codex login
// and the terminal "Log in again" opens, a model the account can't use, and "Choose Agent CLI…" from
// the review's header, back to Claude Code for the next review. The pull request is a stand-in on
// disk (makeRemote) that the fake gh clones, as in pr.test.ts, under its own number (#11) so the
// review state of pr.test.ts's #9 stays apart. Fakes read process.env when they are spawned, so a
// test switches their modes by setting it here.

import * as assert from 'node:assert/strict';
import { existsSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import * as vscode from 'vscode';
import { NEVER_FLAGS } from '../../src/agent/codexCli';
import { makeRemote, PR_TITLE, type FakeRemote } from '../fixtures/fake-gh/makeRemote';
import { errorShown } from './agent.test';
import type { Workbench } from './cdp';
import { graphSettled } from './clicks.test';
import { cdpPort, extensionPath, filos, renderedAfter, shot, sleep, waitFor, workbench } from './helpers';
import { cardIn, clearNotifications, closeAllEditors, draftSel, idsAt, keySel, openTab, qSel, sampleQuestion, snapshot, snapshotWhere, textOf, typeInto } from './pane';
import { arrowDownTo, describeViews, quickInput, quickInputWhere, RANK, readStatus, StatusRecorder, type StatusView } from './pr.test';

const PR_NUMBER = 11;
const PR_URL = `https://github.com/acme/ledger/pull/${PR_NUMBER}`;
const PR_LABEL = `acme/ledger#${PR_NUMBER}`;
const stepLabels = (agent: string) => ['Find the pull request', 'Get the code', `${agent} reads the change`, `${agent} writes questions`];
const MODEL = 'gpt-5.3-codex';
/** What Filos says for the real ChatGPT-account refusal the fake replays (codex-cli 0.160, 2026-10-04). */
const MODEL_MESSAGE = `Codex can't use the model "${MODEL}" with your account: The '${MODEL}' model is not supported when using Codex with a ChatGPT account. To fix it, set filos.codex.model to a model your account supports, or leave it empty for Codex’s default.`;

/** What the fake codex writes to FAKE_CODEX_RECORD when `exec` starts. */
interface CodexRun {
  argv: string[];
  cwd: string;
  flags: Record<string, string | boolean | string[] | undefined>;
  configs: string[];
  disabled: string[];
  task: string;
  hasShell: boolean;
  promptVia: string;
  prompt: string;
  schema?: { type?: string; additionalProperties?: unknown };
  agentEnv: string[];
  /** Filos's rules, as Codex's developer message (-c developer_instructions). */
  developerInstructions?: string;
  /** The permission profile -c default_permissions names, as the fake parsed it. */
  permissions?: { profile: string; filesystem: Record<string, string>; network: { enabled?: boolean } };
  /** What the sandbox is, as codex-cli resolves it: --sandbox wins over a profile. */
  effectiveSandbox: string;
  skillsDisabled: string[];
  bundledSkills: boolean;
}

const readRun = (file: string): CodexRun | undefined => (existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as CodexRun) : undefined);

const settings = () => vscode.workspace.getConfiguration('filos');

/** Writes a Filos setting to user settings (undefined removes it) and waits until it reads back. */
async function setUserSetting(key: string, value: unknown): Promise<void> {
  await settings().update(key, value, vscode.ConfigurationTarget.Global);
  await waitFor(() => settings().inspect(key)?.globalValue === value || undefined, `filos.${key} to read back as ${JSON.stringify(value)}`, 5_000);
}

/** The text of the notification toasts on screen. */
const toasts = (wb: Workbench) =>
  wb.evalPage<string[]>(`[...document.querySelectorAll('.notifications-toasts .notification-list-item-message')].map((e) => e.textContent.replace(/\\s+/g, ' ').trim())`);

export function registerCodexTests(): void {
  describe('Codex as the agent (fake codex CLI, fake gh remote)', function () {
    let wb: Workbench;
    let fake: FakeRemote;
    let run: string;
    let fakeCodex: string;
    /** <globalStorage>/prs/…/worktrees/pr-11-…: where the comprehension pass must run. */
    let worktree: string;
    let commentId = '';

    /**
     * Runs a review that should load, and waits until the graph is drawn and settled. The command
     * resolves once the whole flow has run; a click (Retry, from the error view) returns before the
     * host acts on it, so the wait is for the loaded agent review of this pull request.
     */
    async function reviewLoads(start: () => Thenable<unknown> | Promise<unknown>, what: string): Promise<void> {
      const api = await filos();
      const t0 = Date.now();
      await start();
      await waitFor(() => {
        const s = api.getSession();
        return s?.status.kind === 'loaded' && s.source === 'agent' && s.target.pr?.url === PR_URL ? s : undefined;
      }, `${what} to load`, 30_000);
      await renderedAfter(t0, (r) => r.visibleNodes.length > 0, 20_000);
      await graphSettled(wb);
    }

    /** The header's agent button, as drawn. */
    const agentButton = () => textOf(wb, '.review-controls:not([hidden]) .agent-wrap:not([hidden]) .agent-button');

    before(async function () {
      const r = process.env.FILOS_E2E_RUN;
      fakeCodex = process.env.FILOS_E2E_FAKE_CODEX ?? '';
      if (!cdpPort() || !r || !fakeCodex || !process.env.FILOS_E2E_FAKE_GH || !process.env.FILOS_E2E_FAKE_CLAUDE) this.skip();
      this.timeout(60_000);
      run = r;
      assert.equal(settings().get('codex.path'), fakeCodex, 'filos.codex.path should point at the fake codex');
      assert.equal(settings().get('gh.path'), process.env.FILOS_E2E_FAKE_GH, 'filos.gh.path should point at the fake gh');
      assert.equal(settings().inspect('provider')?.globalValue, undefined, 'the suites before this one run on the default provider');
      wb = await workbench();

      fake = makeRemote(join(run, 'codex-pr-remote'), { number: PR_NUMBER, sample: join(extensionPath(), 'fixtures', 'sample-repo') });
      process.env.FAKE_GH_REMOTE = fake.remote;
      process.env.FAKE_GH_PR_JSON = fake.prFile;
      process.env.FAKE_GH_RECORD = join(run, 'gh-calls-codex.jsonl');
      process.env.FAKE_GH_MODE = 'ok';
      process.env.FAKE_GH_EXTRA_FIELDS = 'baseRefOid';
      process.env.FAKE_CODEX_MODE = 'ok';
      process.env.FAKE_CLAUDE_MODE = 'ok';
      worktree = join(run, 'user-data', 'User', 'globalStorage', 'orphefs.filos', 'prs', 'github.com', 'acme', 'ledger', 'worktrees', `pr-${PR_NUMBER}-${fake.headOid.slice(0, 12)}`);

      const api = await filos();
      await clearNotifications();
      await closeAllEditors();
      await api.resetStoredState();
      // The user's choice, as "Choose Agent CLI…" or the Settings editor would write it.
      await setUserSetting('provider', 'codex');
    });

    after(async () => {
      for (const k of ['FAKE_GH_EXTRA_FIELDS', 'FAKE_GH_REMOTE', 'FAKE_GH_PR_JSON', 'FAKE_GH_RECORD', 'FAKE_CODEX_RECORD', 'FAKE_CODEX_DELAY_MS', 'FAKE_CODEX_MODE_EVALUATE', 'FAKE_CODEX_MODE_THREAD', 'FAKE_CODEX_MODE_DRAFTCOMMENTS', 'FAKE_CODEX_MODE_QUESTIONS', 'FAKE_CLAUDE_RECORD', 'FAKE_CLAUDE_DELAY_MS', 'FAKE_CLAUDE_MODE_QUESTIONS']) {
        delete process.env[k];
      }
      process.env.FAKE_GH_MODE = 'ok';
      process.env.FAKE_CODEX_MODE = 'ok';
      process.env.FAKE_CLAUDE_MODE = 'ok';
      await vscode.commands.executeCommand('workbench.action.closeQuickOpen');
      // Back to the profile runE2E wrote: no provider or Codex model in user settings.
      await settings().update('provider', undefined, vscode.ConfigurationTarget.Global);
      await settings().update('codex.model', undefined, vscode.ConfigurationTarget.Global);
      for (const t of vscode.window.terminals.filter((x) => x.name.startsWith('Filos: '))) t.dispose();
      await clearNotifications();
      await closeAllEditors();
    });

    it('a pull request on Codex: "Codex reads the change", the locked-down codex exec it ran, and a graph "Generated by codex"', async function () {
      this.timeout(90_000);
      const api = await filos();
      // A slow comprehension pass keeps step 3 on screen; the questions run at full speed.
      process.env.FAKE_CODEX_MODE = 'slow';
      process.env.FAKE_CODEX_DELAY_MS = '2500';
      process.env.FAKE_CODEX_MODE_QUESTIONS = 'ok';
      // Variables of a parent agent session in the editor's environment: Codex must not inherit them.
      process.env.CODEX_THREAD_ID = 'e2e-parent-session';
      process.env.CLAUDECODE = '1';
      const record = join(run, 'codex-comprehend.json');
      rmSync(record, { force: true });
      process.env.FAKE_CODEX_RECORD = record;
      // Read while the pass runs, then no more records: the questions run next.
      const started = waitFor(() => (readRun(record)?.task === 'comprehend' ? readRun(record) : undefined), 'the comprehension pass to start', 60_000).finally(() => delete process.env.FAKE_CODEX_RECORD);

      const t0 = Date.now();
      let shotTaken = false;
      const recorder = new StatusRecorder(wb, async (v) => {
        if (shotTaken || v.steps[2]?.state !== 'active') return;
        shotTaken = true;
        await shot('codex-steps');
      });
      let seen: StatusView[];
      try {
        await vscode.commands.executeCommand('filos.reviewPullRequest', PR_URL);
      } finally {
        seen = await recorder.stop();
        delete process.env.CODEX_THREAD_ID;
        delete process.env.CLAUDECODE;
        process.env.FAKE_CODEX_MODE = 'ok';
        delete process.env.FAKE_CODEX_DELAY_MS;
        delete process.env.FAKE_CODEX_MODE_QUESTIONS;
      }

      // The steps carry Codex's name, never went back, and step 3 showed Codex's own progress.
      const trail = `\n  ${describeViews(seen)}`;
      // The webview may come up only once the clone is done (as when this suite runs first): the
      // views that count are those of the comprehension pass, which the slow fake keeps on screen.
      assert.ok(seen.length >= 1, `no step views seen:${trail}`);
      for (const v of seen) {
        assert.equal(v.kind, 'loading', `no error expected:${trail}`);
        assert.deepEqual(v.steps.map((s) => s.label), stepLabels('Codex'));
      }
      for (let i = 0; i < 4; i++) {
        const ranks = seen.map((v) => RANK[v.steps[i].state] ?? -1);
        assert.ok(ranks.every((r, k) => r >= 0 && (k === 0 || r >= ranks[k - 1])), `step ${i + 1} went backwards or failed:${trail}`);
      }
      const reading = seen.find((v) => v.steps[2].state === 'active' && v.steps[2].detail === 'Codex is reading the change…');
      assert.ok(reading, `"Codex reads the change" never showed Codex working:${trail}`);
      assert.deepEqual(reading.steps.map((s) => s.state), ['done', 'done', 'active', 'pending']);

      // What Filos started: codex exec, locked down, in the pull request's worktree, prompt on stdin.
      const exec = await started;
      const wt = realpathSync(worktree);
      assert.equal(exec.argv[0], 'exec');
      assert.equal(exec.flags['--cd'], wt, '-C is the worktree in Filos storage');
      // Filos's permission profile, not --sandbox read-only (which reads the whole disk): commands
      // may read the worktree, the platform's own paths and the codex executable, nothing else.
      assert.equal(exec.flags['--sandbox'], undefined);
      assert.ok(exec.permissions, 'a permission profile');
      assert.equal(exec.effectiveSandbox, `profile:${exec.permissions.profile}`);
      assert.deepEqual(exec.permissions.filesystem, { ':minimal': 'read', [wt]: 'read', [realpathSync(fakeCodex)]: 'read' });
      assert.deepEqual(exec.permissions.network, { enabled: false });
      assert.equal(exec.bundledSkills, false, "Codex's own skills are off");
      assert.ok(exec.disabled.includes('view_image'), 'no image viewer: it reads outside the sandbox');
      for (const f of ['--json', '--ephemeral', '--skip-git-repo-check', '--ignore-rules', '--ignore-user-config']) assert.equal(exec.flags[f], true, `${f} expected`);
      for (const c of ['approval_policy="never"', 'project_doc_max_bytes=0', 'web_search="disabled"', 'skills.include_instructions=false']) assert.ok(exec.configs.includes(c), `-c ${c} expected; got ${JSON.stringify(exec.configs)}`);
      for (const f of NEVER_FLAGS) assert.ok(!exec.argv.some((a) => a === f || a.startsWith(`${f}=`)), `${f} must never be passed`);
      for (const f of ['apps', 'plugins', 'computer_use', 'browser_use', 'hooks', 'multi_agent']) assert.ok(exec.disabled.includes(f), `--disable ${f} expected`);
      assert.equal(exec.hasShell, true, 'the comprehension pass keeps the read-only shell');
      assert.equal(exec.flags['--model'], undefined, 'no -m: Codex’s default model');
      assert.equal(exec.promptVia, 'stdin');
      assert.equal(exec.argv[exec.argv.length - 1], '-');
      assert.equal(exec.schema?.additionalProperties, false, 'a strict output schema');
      assert.match(exec.developerInstructions ?? '', /How this run works \(Codex\)/, 'the rules are the developer message');
      assert.doesNotMatch(exec.prompt, /How this run works \(Codex\)/, 'not on stdin with the PR text');
      assert.match(exec.prompt, /-----BEGIN PR DESCRIPTION [0-9a-f]+-----\nRounding now goes to the nearest even cent/);
      assert.deepEqual(exec.agentEnv.filter((k) => k === 'CODEX_THREAD_ID' || k === 'CLAUDECODE'), [], `parent-session variables reached codex: ${exec.agentEnv.join(', ')}`);

      // The review: Codex's graph of acme/ledger#11, with Codex in the header.
      const s = api.getSession();
      assert.ok(s);
      assert.deepEqual(s.status, { kind: 'loaded' });
      assert.equal(s.source, 'agent');
      assert.equal(s.target.kind, 'pr');
      assert.equal(s.target.pr?.url, PR_URL);
      assert.equal(s.target.repoRoot, wt);
      await renderedAfter(t0, (r) => r.visibleNodes.length > 0, 20_000);
      await graphSettled(wb);
      const header = await wb.evalWebview<{ ref: string; badge: string }>(
        `(d) => { const t = (s) => (d.querySelector(s)?.textContent ?? '').replace(/\\s+/g, ' ').trim(); return { ref: t('.pr-meta .pr-ref'), badge: t('.source-badge') }; }`,
      );
      assert.equal(header.ref, PR_LABEL);
      assert.match(header.badge, /^Generated by codex/);
      assert.equal(api.getPanel()?.title, `Filos: ${PR_TITLE}`);

      // Questions from the fake codex, for the depth it proposes; the header names the agent.
      const q = await snapshotWhere((x) => x.questionsStatus.state === 'ready', 'the questions', 20_000);
      assert.equal(q.agentAvailable, true);
      assert.equal(q.agentName, 'Codex');
      assert.deepEqual(q.questions.map((x) => x.id).sort(), idsAt('standard').sort());
      assert.equal(await wb.waitForWebview<string>(`(d) => (d.querySelector('.agent-button')?.textContent ?? '').replace(/\\s+/g, ' ').trim() || null`, 'the agent button'), 'Agent: Codex▾');
      await clearNotifications();
      await shot('codex-loaded');
    });

    it('Codex grades an open answer: "Codex is reading your answer…", a hint "Feedback from Codex", then correct', async () => {
      await clearNotifications();
      await openTab(wb, 'questions');
      if ((await textOf(wb, keySel('questions:showAll'))).startsWith('Show all')) await wb.clickWebview(keySel('questions:showAll'));
      const n = idsAt('standard').length;
      await wb.waitForWebview<boolean>(`(d, w, f, n) => d.querySelectorAll('#filos-panel-questions [data-question-id]').length === n`, `all ${n} question cards`, 5_000, n);
      const q = sampleQuestion('q-checkout-web');
      assert.equal(q.choices, undefined, 'fixture changed: q-checkout-web should be an open question');
      assert.equal(await textOf(wb, `${qSel(q.id)} .cost-note`), 'Uses Codex · small cost');

      const box = draftSel(`answer:${q.id}`);
      const first = 'Nothing changes for checkout-web.';
      assert.equal(await typeInto(wb, box, first), first);
      // Slow enough to see the wait: the grading call takes a second and a half.
      process.env.FAKE_CODEX_MODE_EVALUATE = 'slow';
      process.env.FAKE_CODEX_DELAY_MS = '1500';
      try {
        await wb.clickWebview(keySel(`q:${q.id}:submit`));
        await wb.waitForWebview<boolean>(
          `(d, w, f, sel) => (d.querySelector(sel)?.textContent ?? '').includes('Codex is reading your answer…')`,
          'the grading spinner naming Codex',
          5_000,
          qSel(q.id),
        );
        await shot('codex-grading');
        let card = await cardIn(wb, q.id, 'retry', '', 20_000);
        assert.match(card.feedback, /Not quite\. Look at the branch that only runs on an exact tie/);
        assert.match(card.feedback, /Feedback from Codex/);
      } finally {
        delete process.env.FAKE_CODEX_MODE_EVALUATE;
        delete process.env.FAKE_CODEX_DELAY_MS;
      }

      const second = 'Ties now round half-even, so its cart totals can differ from the invoices by a cent.';
      assert.equal(await typeInto(wb, box, second), second);
      await wb.clickWebview(keySel(`q:${q.id}:submit`));
      const card = await cardIn(wb, q.id, 'done', '', 20_000);
      assert.equal(card.verdict, 'correct');
      assert.match(card.feedback, /exact ties now go to the even cent/);
      assert.deepEqual(
        (await snapshot()).answers[q.id].attempts.map((a) => [a.verdict, a.by]),
        [
          ['incorrect', 'agent'],
          ['correct', 'agent'],
        ],
      );
      await shot('codex-graded');
    });

    it('a Discuss thread gets Codex’s reply and rewrite, and Codex drafts a comment: both without a shell', async () => {
      await clearNotifications();
      await wb.clickWebview(`${qSel('q-round-default')} [data-choice-id="keep-half-up"]`);
      let s = await snapshotWhere((x) => x.comments.length === 1, 'the drafted comment');
      const c = s.comments[0];
      commentId = c.id;

      await openTab(wb, 'comments');
      await wb.clickWebview(keySel(`c:${c.id}:discuss`));
      const message = 'Make this shorter and suggest a test the author could add.';
      assert.equal(await typeInto(wb, draftSel(`thread:${c.id}`), message), message);
      const record = join(run, 'codex-task.json');
      rmSync(record, { force: true });
      process.env.FAKE_CODEX_RECORD = record;
      process.env.FAKE_CODEX_MODE_THREAD = 'slow';
      process.env.FAKE_CODEX_DELAY_MS = '1500';
      try {
        await wb.clickWebview(keySel(`c:${c.id}:send`));
        await wb.waitForWebview<boolean>(`(d, w, f, sel) => (d.querySelector(sel + ' .thread')?.textContent ?? '').includes('Codex is replying…')`, 'the thread spinner naming Codex', 5_000, `[data-comment-id=${JSON.stringify(c.id)}]`);
        s = await snapshotWhere((x) => {
          const y = x.comments.find((z) => z.id === c.id);
          return !!y && !y.threadPending && y.thread.length === 2;
        }, 'Codex’s reply', 20_000);
      } finally {
        delete process.env.FAKE_CODEX_MODE_THREAD;
        delete process.env.FAKE_CODEX_DELAY_MS;
      }
      const reply = s.comments.find((z) => z.id === c.id)!.thread[1];
      assert.equal(reply.role, 'agent');
      assert.equal(reply.text, 'Agreed. Naming a concrete input makes the request easy to act on; here is a tighter version.');
      assert.equal(reply.proposal, 'Could you add a test for an exact half-cent tie, for example 2.345 -> 2.34? It is the one input whose result this PR changes.');
      const drawn = await wb.waitForWebview<string[]>(
        `(d, w, f, sel) => { const who = [...d.querySelectorAll(sel + ' .thread-list .msg-who')].map((e) => e.textContent); return who.length === 2 ? who : null; }`,
        'both messages drawn',
        5_000,
        `[data-comment-id=${JSON.stringify(c.id)}]`,
      );
      assert.deepEqual(drawn, ['You', 'Codex']);
      // The thread task ran with no tools: no shell, no image viewer.
      const thread = readRun(record);
      assert.ok(thread, 'the thread ran codex');
      assert.equal(thread.task, 'thread');
      assert.equal(thread.hasShell, false);
      for (const f of ['shell_tool', 'unified_exec', 'view_image']) assert.ok(thread.disabled.includes(f), `--disable ${f} expected for the thread`);
      assert.equal(thread.flags['--cd'], realpathSync(worktree));
      await shot('codex-thread');

      await wb.clickWebview(keySel(`c:${c.id}:adopt:1`));
      await snapshotWhere((x) => x.comments.find((z) => z.id === c.id)?.body === reply.proposal, 'the proposal adopted');

      // Codex drafts one more from the answers.
      rmSync(record, { force: true });
      const before = (await snapshot()).comments.length;
      try {
        await wb.clickWebview(keySel('draft:agent'));
        s = await snapshotWhere((x) => !x.draftingPending && x.comments.length > before, 'Codex’s draft', 20_000);
      } finally {
        delete process.env.FAKE_CODEX_RECORD;
      }
      const drafted = s.comments.filter((z) => z.origin.kind === 'agent');
      assert.equal(drafted.length, 1);
      assert.match(drafted[0].body, /^This changes results for existing callers\./);
      const draft = readRun(record);
      assert.ok(draft, 'drafting ran codex');
      assert.equal(draft.task, 'draftComments');
      assert.equal(draft.hasShell, false);
      await wb.waitForWebview<boolean>(`(d) => (d.querySelector('#filos-panel-comments')?.textContent ?? '').includes('Drafted by Codex')`, 'the "Drafted by Codex" tag', 5_000);
      await shot('codex-comments');
    });

    it('an expired Codex login: "Log in again" opens a terminal that runs `codex login`; "Show sample instead" recovers', async function () {
      this.timeout(60_000);
      const api = await filos();
      await clearNotifications();
      process.env.FAKE_CODEX_MODE = 'auth';
      try {
        await vscode.commands.executeCommand('filos.reviewSampleWithAgent');
        const st = api.getSession()?.status;
        assert.ok(st?.kind === 'error', `expected an error, got ${JSON.stringify(st)}`);
        assert.equal(st.message, 'Your Codex session has expired.');
        assert.deepEqual(st.actions, ['login', 'retry', 'useFixture']);
        assert.ok((st.detail ?? '').includes(`\`${fakeCodex} login\``), `the detail names the login command: ${st.detail}`);

        const shown = await errorShown(wb);
        assert.equal(shown.message, 'Your Codex session has expired.');
        assert.deepEqual(shown.actions, [
          ['login', 'Log in again'],
          ['retry', 'Retry'],
          ['useFixture', 'Show sample instead'],
        ]);
        await shot('codex-auth-error');

        await wb.clickWebview('.status--error button[data-action="login"]');
        const terminal = await waitFor(() => vscode.window.terminals.find((t) => t.name === 'Filos: Codex login'), 'the "Filos: Codex login" terminal');
        // The CLI itself, with `login`: no shell parses the command, and it starts from home.
        const opts = terminal.creationOptions as vscode.TerminalOptions;
        assert.equal(opts.shellPath, fakeCodex);
        assert.deepEqual(opts.shellArgs, ['login']);
        assert.equal(typeof opts.cwd === 'string' ? opts.cwd : opts.cwd?.fsPath, homedir());
        assert.ok(!vscode.window.terminals.some((t) => t.name === 'Filos: Claude Code login'), 'not the Claude Code login');
        await sleep(300);
        await shot('codex-login-terminal');
        // The fake's `codex login` succeeds and exits.
        const exit = await waitFor(() => terminal.exitStatus, 'the codex login to exit', 15_000);
        assert.equal(exit.code, 0);
        terminal.dispose();
        await vscode.commands.executeCommand('workbench.action.closePanel');
      } finally {
        process.env.FAKE_CODEX_MODE = 'ok';
      }

      const t = Date.now();
      await wb.clickWebview('.status--error button[data-action="useFixture"]');
      await waitFor(() => {
        const x = api.getSession();
        return x?.status.kind === 'loaded' && x.source === 'fixture';
      }, 'the sample to load');
      await renderedAfter(t, (x) => x.visibleNodes.length > 0);
      await clearNotifications();
    });

    it('Codex’s usage limit is the account’s, not a Filos spending cap', async function () {
      const api = await filos();
      await clearNotifications();
      process.env.FAKE_CODEX_MODE = 'quota';
      try {
        await vscode.commands.executeCommand('filos.reviewSampleWithAgent');
      } finally {
        process.env.FAKE_CODEX_MODE = 'ok';
      }
      const st = api.getSession()?.status;
      assert.ok(st?.kind === 'error', `expected an error, got ${JSON.stringify(st)}`);
      assert.equal(st.message, 'Codex reached a usage limit before finishing.');
      assert.match(st.detail ?? '', /^Codex hit a usage or rate limit of your account \(not a Filos cap\): You've hit your usage limit\./);
      assert.ok(!/maxBudgetUsd|spending cap/.test(`${st.message}\n${st.detail}`), 'no word of the Claude Code budget setting');
      const shown = await errorShown(wb);
      assert.equal(shown.message, 'Codex reached a usage limit before finishing.');
      assert.deepEqual(shown.actions.map(([a]) => a), ['retry', 'useFixture']);
      await shot('codex-usage-limit');
      await wb.clickWebview('.status--error button[data-action="useFixture"]');
      await waitFor(() => {
        const x = api.getSession();
        return x?.status.kind === 'loaded' && x.source === 'fixture';
      }, 'the sample to load');
      await clearNotifications();
    });

    it('Codex not found: the error offers "Choose agent…", whose picker shows Codex as not found', async function () {
      this.timeout(60_000);
      const api = await filos();
      await clearNotifications();
      const missing = join(run, 'no-such-dir', 'codex');
      await setUserSetting('codex.path', missing);
      let settled = false;
      try {
        await vscode.commands.executeCommand('filos.reviewSampleWithAgent');
        const st = api.getSession()?.status;
        assert.ok(st?.kind === 'error', `expected an error, got ${JSON.stringify(st)}`);
        assert.equal(st.message, "Filos can't find the Codex CLI.");
        assert.ok((st.detail ?? '').includes(`set the setting "filos.codex.path" to the full path of the executable (it is "${missing}" now)`), st.detail);
        const shown = await errorShown(wb);
        assert.deepEqual(shown.actions, [
          ['retry', 'Retry'],
          ['chooseAgent', 'Choose agent…'],
          ['useFixture', 'Show sample instead'],
        ]);
        await shot('codex-not-found');

        await wb.clickWebview('.status--error button[data-action="chooseAgent"]');
        const picker = await quickInputWhere(
          wb,
          (q) => /Filos: Choose the agent CLI/.test(q.title) && q.rows.length === 2 && !q.rows.some((r) => /Checking/.test(r.text)),
          'the agent picker with both CLIs checked',
          15_000,
        );
        assert.match(picker.rows[0].text, /^Claude Code.*Installed and logged in/);
        assert.match(picker.rows[1].text, /^Codex/);
        assert.ok(picker.rows[1].text.includes(missing), picker.rows[1].text);
        assert.match(picker.rows[1].text, /Not found\. Install it, or set filos\.codex\.path/);
        await shot('codex-not-found-picker');
        await wb.press('Escape');
        await waitFor(async () => (await quickInput(wb)) === null, 'the picker to close', 5_000);
        settled = true;
        assert.equal(settings().inspect('provider')?.globalValue, 'codex', 'Escape changes nothing');
      } finally {
        if (!settled) await vscode.commands.executeCommand('workbench.action.closeQuickOpen');
        await setUserSetting('codex.path', fakeCodex);
      }
      await wb.clickWebview('.status--error button[data-action="useFixture"]');
      await waitFor(() => {
        const x = api.getSession();
        return x?.status.kind === 'loaded' && x.source === 'fixture';
      }, 'the sample to load');
      await clearNotifications();
    });

    it('a model the ChatGPT account can’t use: "Codex reads the change" fails with a message naming filos.codex.model; Retry without it loads', async function () {
      this.timeout(90_000);
      const api = await filos();
      await clearNotifications();
      const record = join(run, 'codex-model.json');
      rmSync(record, { force: true });
      process.env.FAKE_CODEX_RECORD = record;
      try {
        await setUserSetting('codex.model', MODEL);
        process.env.FAKE_CODEX_MODE = 'model';
        await vscode.commands.executeCommand('filos.reviewPullRequest', PR_URL);
        const st = api.getSession()?.status;
        assert.ok(st?.kind === 'error', `expected an error, got ${JSON.stringify(st)}`);
        assert.equal(st.message, MODEL_MESSAGE);
        assert.deepEqual(st.actions, ['retry']);
        assert.deepEqual(st.steps?.map((x) => x.state), ['done', 'done', 'failed', 'pending']);
        // The model setting reached codex as -m.
        assert.equal(readRun(record)?.flags['--model'], MODEL);

        const shown = await waitFor(async () => {
          const v = await readStatus(wb);
          return v?.kind === 'error' ? v : undefined;
        }, 'the error view with steps');
        assert.equal(shown.message, MODEL_MESSAGE);
        assert.deepEqual(
          shown.steps.map((x) => [x.label, x.state]),
          stepLabels('Codex').map((l, i) => [l, i < 2 ? 'done' : i === 2 ? 'failed' : 'pending']),
        );
        assert.deepEqual(shown.actions, ['retry']);
        await shot('codex-model-error');

        // As the message says: clear the model (Codex's default), then Retry.
        await setUserSetting('codex.model', undefined);
        process.env.FAKE_CODEX_MODE = 'ok';
        rmSync(record, { force: true });
        await reviewLoads(() => wb.clickWebview('.status--error button[data-action="retry"]'), 'the retried review');
      } finally {
        process.env.FAKE_CODEX_MODE = 'ok';
        delete process.env.FAKE_CODEX_RECORD;
        await settings().update('codex.model', undefined, vscode.ConfigurationTarget.Global);
      }
      const retried = readRun(record);
      assert.ok(retried, 'the retry ran codex');
      assert.equal(retried.flags['--model'], undefined, 'no -m once the setting is empty');
      assert.match(await textOf(wb, '.source-badge'), /^Generated by codex/);
      await snapshotWhere((x) => x.questionsStatus.state === 'ready', 'the questions', 20_000);
      await clearNotifications();
    });

    it('"Choose Agent CLI…" from the header switches filos.provider to claude: the open review says Claude Code, and the next review runs the fake claude', async function () {
      this.timeout(90_000);
      const api = await filos();
      await clearNotifications();
      assert.equal(await agentButton(), 'Agent: Codex▾');

      // The header's agent button opens the picker; both fakes are installed and logged in.
      let settled = false;
      await wb.clickWebview('.agent-button');
      try {
        const picker = await quickInputWhere(
          wb,
          (q) => /Filos: Choose the agent CLI/.test(q.title) && q.rows.length === 2 && q.rows.every((r) => /Installed and logged in/.test(r.text)),
          'the agent picker with both CLIs checked',
          15_000,
        );
        const [claudeRow, codexRow] = picker.rows;
        assert.match(claudeRow.text, /^Claude Code/);
        assert.ok(claudeRow.text.includes(process.env.FILOS_E2E_FAKE_CLAUDE!), claudeRow.text);
        assert.ok(!/current/.test(claudeRow.text), claudeRow.text);
        assert.match(codexRow.text, /^Codex/);
        assert.ok(codexRow.text.includes(fakeCodex), codexRow.text);
        assert.match(codexRow.text, /current/);
        await shot('codex-agent-picker');
        await arrowDownTo(wb, /^Claude Code/);
        await wb.press('Enter');
        await waitFor(async () => (await quickInput(wb)) === null, 'the picker to close', 5_000);
        settled = true;
      } finally {
        if (!settled) await vscode.commands.executeCommand('workbench.action.closeQuickOpen');
      }

      // Written to user settings; the open review's wording follows at once.
      await waitFor(() => settings().inspect('provider')?.globalValue === 'claude', 'filos.provider to be claude in user settings', 5_000);
      assert.equal(settings().inspect('provider')?.workspaceValue, undefined);
      await waitFor(async () => (await agentButton()) === 'Agent: Claude Code▾', 'the header to say Claude Code', 5_000);
      assert.equal((await snapshot()).agentName, 'Claude Code');
      await waitFor(async () => (await toasts(wb)).some((m) => m === 'Filos: agent steps now run on Claude Code.'), 'the "now run on Claude Code" notification', 5_000);
      await shot('codex-switched');
      await clearNotifications();

      // The next review runs the fake claude, and nothing runs codex.
      const codexRecord = join(run, 'codex-after-switch.json');
      rmSync(codexRecord, { force: true });
      process.env.FAKE_CODEX_RECORD = codexRecord;
      const claudeRecord = join(run, 'claude-after-switch.json');
      rmSync(claudeRecord, { force: true });
      process.env.FAKE_CLAUDE_RECORD = claudeRecord;
      process.env.FAKE_CLAUDE_MODE = 'slow';
      process.env.FAKE_CLAUDE_DELAY_MS = '1500';
      process.env.FAKE_CLAUDE_MODE_QUESTIONS = 'ok';
      const claudeStarted = waitFor(() => {
        const r = existsSync(claudeRecord) ? (JSON.parse(readFileSync(claudeRecord, 'utf8')) as { task: string; cwd: string }) : undefined;
        return r?.task === 'comprehend' ? r : undefined;
      }, 'the fake claude’s comprehension pass to start', 60_000).finally(() => delete process.env.FAKE_CLAUDE_RECORD);
      const recorder = new StatusRecorder(wb);
      let seen: StatusView[];
      try {
        await reviewLoads(() => vscode.commands.executeCommand('filos.reviewPullRequest', PR_URL), 'the review on Claude Code');
      } finally {
        seen = await recorder.stop();
        process.env.FAKE_CLAUDE_MODE = 'ok';
        delete process.env.FAKE_CLAUDE_DELAY_MS;
        delete process.env.FAKE_CLAUDE_MODE_QUESTIONS;
      }
      const trail = `\n  ${describeViews(seen)}`;
      assert.ok(seen.length >= 1, `no step views seen:${trail}`);
      for (const v of seen) assert.deepEqual(v.steps.map((s) => s.label), stepLabels('Claude Code'), trail);
      assert.ok(seen.some((v) => v.steps[2].state === 'active'), `"Claude Code reads the change" was never shown running:${trail}`);
      const comprehend = await claudeStarted;
      assert.equal(comprehend.cwd, realpathSync(worktree));
      assert.match(await textOf(wb, '.source-badge'), /^Generated by claude/);
      assert.equal(await agentButton(), 'Agent: Claude Code▾');
      const q = await snapshotWhere((x) => x.questionsStatus.state === 'ready', 'the questions from the fake claude', 20_000);
      assert.equal(q.agentName, 'Claude Code');
      await sleep(300);
      delete process.env.FAKE_CODEX_RECORD;
      assert.ok(!existsSync(codexRecord), 'codex exec never ran after the switch');
      // The pull request's answers, made with Codex, are still there.
      assert.equal(q.answers['q-checkout-web']?.done, true);
      assert.ok(q.comments.some((c) => c.id === commentId));
      await shot('codex-back-to-claude');
      await clearNotifications();
    });
  });
}

// The Claude provider end to end against the fake CLI (test/fixtures/fake-claude), one test per mode.

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { createProvider, ProviderError, type ProviderConfig } from '../../src/agent';
import { runProcess } from '../../src/agent/exec';
import type { ComprehensionRequest } from '../../src/agent/provider';
import { FAKE_CLAUDE, FAKE_DIFF, FAKE_INDEX, FAKE_REPO, fixtureGraph } from './helpers';

const scratch = mkdtempSync(join(tmpdir(), 'filos-provider-'));
after(() => rmSync(scratch, { recursive: true, force: true }));

function provider(mode: string, extra: Partial<ProviderConfig> = {}, env: Record<string, string> = {}) {
  return createProvider({ id: 'claude', claudePath: FAKE_CLAUDE, model: 'sonnet', maxBudgetUsd: 0.5, timeoutSeconds: 30, env: { FAKE_CLAUDE_MODE: mode, ...env }, ...extra });
}

function request(extra: Partial<ComprehensionRequest> = {}): ComprehensionRequest {
  return { repoRoot: FAKE_REPO, diff: FAKE_DIFF, base: 'main', head: 'bankers-rounding', prTitle: "Use banker's rounding", dependencyIndex: FAKE_INDEX, ...extra };
}

async function rejectsWith(p: Promise<unknown>, kind: ProviderError['kind']): Promise<ProviderError> {
  try {
    await p;
  } catch (err) {
    assert.ok(err instanceof ProviderError, `expected ProviderError, got ${String(err)}`);
    assert.equal(err.kind, kind, `expected kind ${kind}, got ${err.kind}: ${err.message}\n${err.detail ?? ''}`);
    return err;
  }
  assert.fail(`expected a ${kind} ProviderError, but the call succeeded`);
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

async function waitUntil(cond: () => boolean, ms: number) {
  const end = Date.now() + ms;
  while (!cond() && Date.now() < end) await new Promise((r) => setTimeout(r, 25));
  return cond();
}

describe('ClaudeCliProvider with the fake CLI', () => {
  it('ok: returns a validated graph, owned fields filled in, prompt sent on stdin', async () => {
    const record = join(scratch, 'ok.json');
    const progress: string[] = [];
    const p = provider('ok', {}, { FAKE_CLAUDE_RECORD: record });
    const res = await p.comprehend(request({ onProgress: (m) => progress.push(m) }));

    assert.equal(res.graph.nodes.length, 7);
    assert.deepEqual(res.graph.pr, { title: "Use banker's rounding", base: 'main', head: 'bankers-rounding' });
    assert.equal(res.graph.generatedBy?.provider, 'claude');
    assert.equal(res.graph.generatedBy?.model, 'claude-fake-sonnet');
    assert.ok(!Number.isNaN(Date.parse(res.graph.generatedBy?.at ?? '')), 'generatedBy.at is an ISO time');
    assert.equal(res.costUsd, 0.0123);
    assert.equal(typeof res.durationMs, 'number');
    assert.deepEqual(res.warnings, []);
    assert.ok(progress.includes('Reading money/round.ts'), progress.join(' | '));
    assert.ok(progress.some((m) => m.startsWith('Searching for')));
    assert.equal(progress.filter((m) => m.startsWith('Thinking')).length, 1, 'repeated progress is collapsed');
    assert.equal(progress[progress.length - 1], 'Checking the graph against the contract…');

    const rec = JSON.parse(readFileSync(record, 'utf8'));
    assert.equal(rec.promptVia, 'stdin');
    assert.equal(rec.cwd, FAKE_REPO);
    assert.ok(rec.prompt.includes('-----BEGIN DIFF-----') && rec.prompt.includes('+  const floor = Math.floor(cents);'));
    assert.ok(rec.prompt.includes('ext:invoice-service'), 'dependency index is in the prompt');
    assert.ok(!rec.argv.some((a: string) => a.includes('Math.floor')), 'the diff never goes into argv');
    assert.equal(rec.flags['--tools'], 'Read,Grep,Glob');
    assert.equal(rec.flags['--permission-mode'], 'dontAsk');
    assert.equal(rec.flags['--max-budget-usd'], '0.5');
    assert.equal(rec.schema.properties.contractVersion.enum[0], '0.1');
    for (const v of ['CLAUDECODE', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_CODE_SDK_HAS_HOST_AUTH_REFRESH', 'CLAUDE_CODE_MESSAGING_TOKEN']) {
      assert.ok(!rec.claudeEnv.includes(v), `${v} must not reach the CLI`);
    }
  });

  it('ok: strips parent-session variables even when the host has them', async () => {
    const record = join(scratch, 'env.json');
    const saved = process.env.CLAUDECODE;
    process.env.CLAUDECODE = '1';
    try {
      await provider('ok', {}, { FAKE_CLAUDE_RECORD: record }).comprehend(request());
    } finally {
      if (saved === undefined) delete process.env.CLAUDECODE;
      else process.env.CLAUDECODE = saved;
    }
    assert.ok(!JSON.parse(readFileSync(record, 'utf8')).claudeEnv.includes('CLAUDECODE'));
  });

  it('ok: the prompt can also go in argv', async () => {
    const record = join(scratch, 'argv.json');
    const res = await provider('ok', { promptVia: 'argv' }, { FAKE_CLAUDE_RECORD: record }).comprehend(request());
    assert.equal(res.graph.nodes.length, 7);
    const rec = JSON.parse(readFileSync(record, 'utf8'));
    assert.equal(rec.promptVia, 'argv');
    assert.equal(rec.argv[rec.argv.length - 2], '--');
  });

  it('ok: returns a graph supplied through FAKE_CLAUDE_GRAPH (as e2e does)', async () => {
    const custom = join(scratch, 'custom-graph.json');
    writeFileSync(custom, JSON.stringify({ ...fixtureGraph(), orientation: 'A custom orientation from FAKE_CLAUDE_GRAPH.' }));
    const res = await provider('ok', {}, { FAKE_CLAUDE_GRAPH: custom }).comprehend(request());
    assert.equal(res.graph.orientation, 'A custom orientation from FAKE_CLAUDE_GRAPH.');
  });

  it('ok: absolute paths under the repo (as the Read tool uses them) are made repo-relative, not dropped', async () => {
    const root = realpathSync(FAKE_REPO);
    const g = fixtureGraph();
    for (const n of g.nodes) for (const a of n.anchors) a.file = join(root, a.file);
    for (const f of g.files) f.path = join(root, f.path);
    const custom = join(scratch, 'absolute-graph.json');
    writeFileSync(custom, JSON.stringify(g));
    const res = await provider('ok', {}, { FAKE_CLAUDE_GRAPH: custom }).comprehend(request());
    const want = fixtureGraph();
    assert.deepEqual(res.graph.nodes.map((n) => n.anchors.map((a) => a.file)), want.nodes.map((n) => n.anchors.map((a) => a.file)));
    assert.deepEqual(res.graph.files.map((f) => f.path), want.files.map((f) => f.path));
    assert.ok(res.warnings.some((w) => w.startsWith('repaired: made absolute path')), res.warnings.join('\n'));
  });

  it('fenced: falls back to JSON inside the text answer', async () => {
    const res = await provider('fenced').comprehend(request());
    assert.equal(res.graph.nodes.length, 7);
  });

  it('auth: an OAuth refresh failure is authExpired, raw message kept', async () => {
    const err = await rejectsWith(provider('auth').comprehend(request()), 'authExpired');
    assert.match(err.detail ?? '', /Failed to refresh OAuth token/);
  });

  it('auth: a login error on stderr only is authExpired too', async () => {
    const err = await rejectsWith(provider('crash', {}, { FAKE_CLAUDE_MESSAGE: 'Invalid API key · Please run /login' }).comprehend(request()), 'authExpired');
    assert.match(err.detail ?? '', /Invalid API key/);
  });

  it('contract: structural violations are rejected with the validation errors as detail', async () => {
    const err = await rejectsWith(provider('contract').comprehend(request()), 'contract');
    assert.match(err.detail ?? '', /unknown target/);
    // Line-number slips are repaired, not reported: only the structural error remains.
    assert.doesNotMatch(err.detail ?? '', /exceed money\/round.ts/);
  });

  it('slow + short timeout: timeout, and the whole process tree is killed', async () => {
    const pidfile = join(scratch, 'slow-pids.json');
    const started = Date.now();
    await rejectsWith(provider('slow', { timeoutSeconds: 1 }, { FAKE_CLAUDE_PIDFILE: pidfile }).comprehend(request()), 'timeout');
    assert.ok(Date.now() - started < 10_000, 'gave up promptly');
    const { cli, helper } = JSON.parse(readFileSync(pidfile, 'utf8'));
    assert.ok(await waitUntil(() => !alive(cli) && !alive(helper), 3000), 'CLI and its helper are gone');
  });

  it('abort: cancelled, promptly', async () => {
    const ac = new AbortController();
    const started = Date.now();
    setTimeout(() => ac.abort(), 300);
    await rejectsWith(provider('slow').comprehend(request({ signal: ac.signal })), 'cancelled');
    assert.ok(Date.now() - started < 5000);
  });

  it('abort before start: cancelled without running anything', async () => {
    const record = join(scratch, 'never.json');
    const ac = new AbortController();
    ac.abort();
    await rejectsWith(provider('ok', {}, { FAKE_CLAUDE_RECORD: record }).comprehend(request({ signal: ac.signal })), 'cancelled');
    assert.throws(() => readFileSync(record));
  });

  it('crash: failed, with stderr as detail', async () => {
    const err = await rejectsWith(provider('crash').comprehend(request()), 'failed');
    assert.match(err.detail ?? '', /TypeError/);
  });

  it('budget: the spending cap is reported as budget', async () => {
    const err = await rejectsWith(provider('budget').comprehend(request()), 'budget');
    assert.match(err.message, /\$0\.5/);
  });

  it('badtools: refuses a CLI that offers Bash/Edit/Write, without waiting for it', async () => {
    const started = Date.now();
    const err = await rejectsWith(provider('badtools', {}, { FAKE_CLAUDE_DELAY_MS: '20000' }).comprehend(request()), 'failed');
    assert.match(err.message, /Bash, Edit, Write/);
    assert.ok(Date.now() - started < 5000);
  });

  it('missing CLI: notInstalled', async () => {
    const p = createProvider({ id: 'claude', claudePath: join(scratch, 'no-such-claude'), maxBudgetUsd: 1, timeoutSeconds: 5 });
    await rejectsWith(p.comprehend(request()), 'notInstalled');
    await rejectsWith(p.checkReady(), 'notInstalled');
  });

  it('missing repo folder: failed, not mistaken for a missing CLI', async () => {
    const err = await rejectsWith(provider('ok').comprehend(request({ repoRoot: join(scratch, 'no-such-repo') })), 'failed');
    assert.match(err.message, /Repository folder not found/);
  });

  it('checkReady: passes when logged in, authExpired when not', async () => {
    await provider('ok').checkReady();
    const err = await rejectsWith(provider('auth').checkReady(), 'authExpired');
    assert.match(err.detail ?? '', /"loggedIn": false/);
  });

  it('loginCommand points at the configured CLI', () => {
    assert.equal(createProvider({ id: 'claude', claudePath: 'claude', maxBudgetUsd: 1, timeoutSeconds: 5 }).loginCommand, 'claude auth login');
    const spaced = createProvider({ id: 'claude', claudePath: '/opt/my tools/claude', maxBudgetUsd: 1, timeoutSeconds: 5 });
    assert.equal(spaced.loginCommand, '"/opt/my tools/claude" auth login');
    assert.deepEqual(spaced.login, { command: '/opt/my tools/claude', args: ['auth', 'login'] }, 'unquoted, for a terminal that runs it without a shell');
  });

  it('ok: a timeout of 0 means the default, not "kill at once"', async () => {
    const res = await provider('ok', { timeoutSeconds: 0 }).comprehend(request());
    assert.equal(res.graph.nodes.length, 7);
  });
});

describe('runProcess', () => {
  it('treats a timeout beyond what setTimeout can hold as long, not as "now"', async () => {
    const r = await runProcess({ command: process.execPath, args: ['-e', 'setTimeout(() => {}, 200)'], cwd: process.cwd(), timeoutMs: 3_000_000_000 });
    assert.equal(r.timedOut, false);
    assert.equal(r.exitCode, 0);
  });
});

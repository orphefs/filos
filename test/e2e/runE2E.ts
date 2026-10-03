// Runs the e2e suite inside a real VS Code, headless. Bundled to dist/test/runE2E.js by esbuild.mjs.
//
//   npm run test:e2e                 build, then run everything
//   npm run test:e2e -- --grep fold  only tests whose title matches
//   FILOS_E2E_KEEP=1                 keep the temporary profile and workspace for inspection
//   FILOS_E2E_HEADED=1               run on the current display instead of a private Xvfb
//   node dist/test/runE2E.js --vsix dist/filos.vsix
//                                    run against the unpacked package instead of the repo, which
//                                    proves the .vsix carries every file the extension needs
//
// On Linux it re-executes itself under `xvfb-run`, so VS Code never opens on the user's desktop.
// VS Code also gets a scrubbed environment: no parent-session tokens, IPC hooks or session bus.

import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { delimiter, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { runTests } from '@vscode/test-electron';

/** dist/test/runE2E.js -> repo root. */
const ROOT = resolve(__dirname, '..', '..');
const INSTALLED_VSCODE = '/usr/share/code/code';
const SCREEN = '1920x1080x24';


function onPath(cmd: string): boolean {
  return (process.env.PATH ?? '').split(delimiter).some((dir) => dir && existsSync(join(dir, cmd)));
}

/** xvfb-run points XAUTHORITY at its own temp dir; FILOS_E2E_XVFB marks our own re-exec. */
function underXvfb(): boolean {
  return process.env.FILOS_E2E_XVFB === '1' || /xvfb-run/.test(process.env.XAUTHORITY ?? '');
}

/** Returns an exit code when this process re-executed itself (or refused to run), else undefined. */
function ensureHeadless(): number | undefined {
  if (process.platform !== 'linux' || underXvfb() || process.env.FILOS_E2E_HEADED === '1') return undefined;
  if (!onPath('xvfb-run')) {
    console.error(
      'Filos e2e: xvfb-run was not found. Install it (apt install xvfb) so VS Code runs on a private display,\n' +
        'or set FILOS_E2E_HEADED=1 to let it open windows on the current display.',
    );
    return 2;
  }
  const r = spawnSync('xvfb-run', ['-a', '-s', `-screen 0 ${SCREEN}`, process.execPath, __filename, ...process.argv.slice(2)], {
    stdio: 'inherit',
    env: { ...process.env, FILOS_E2E_XVFB: '1' },
  });
  if (r.error) {
    console.error(`Filos e2e: could not start xvfb-run: ${r.error.message}`);
    return 2;
  }
  return r.status ?? 1;
}

/**
 * Only what VS Code needs reaches it. runTests() merges process.env into the child's environment,
 * so this edits process.env itself. Dropped on purpose: tokens of a parent Claude Code session,
 * VS Code IPC hooks and ELECTRON_RUN_AS_NODE (which would make the binary run as plain Node), and
 * the D-Bus session (a keyring prompt or notification would land on the real desktop).
 */
function scrubEnvironment(runtimeDir: string): void {
  const keep = /^(HOME|PATH|USER|LOGNAME|SHELL|LANG|LANGUAGE|LC_[A-Z]+|TZ|TMPDIR|TERM|DISPLAY|XAUTHORITY|https?_proxy|HTTPS?_PROXY|no_proxy|NO_PROXY|NODE_EXTRA_CA_CERTS|FILOS_E2E_[A-Z_]+)$/;
  for (const key of Object.keys(process.env)) if (!keep.test(key)) delete process.env[key];
  process.env.XDG_RUNTIME_DIR = runtimeDir;
}

function freePort(): Promise<number> {
  return new Promise((ok, fail) => {
    const srv = createServer();
    srv.once('error', fail);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      srv.close(() => (port ? ok(port) : fail(new Error('no free port'))));
    });
  });
}

/**
 * A workspace that is a git repo on a feature branch, for "Review Current Branch": the sample's base
 * committed on main, its head on feature/x, plus one uncommitted edit (which the review must flag).
 */
function makeWorkspace(dir: string): void {
  mkdirSync(dir, { recursive: true });
  const env = { ...process.env, GIT_AUTHOR_NAME: 'Filos E2E', GIT_AUTHOR_EMAIL: 'e2e@filos.invalid', GIT_COMMITTER_NAME: 'Filos E2E', GIT_COMMITTER_EMAIL: 'e2e@filos.invalid' };
  const git = (...args: string[]) => execFileSync('git', ['-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', '-c', 'core.autocrlf=false', ...args], { cwd: dir, env, stdio: 'pipe' });
  git('init', '-q');
  git('symbolic-ref', 'HEAD', 'refs/heads/main');
  cpSync(join(ROOT, 'fixtures', 'sample-repo', 'base'), dir, { recursive: true });
  git('add', '-A');
  git('commit', '-q', '--no-verify', '-m', 'Ledger: money, invoices, VAT and the HTTP handler');
  git('checkout', '-q', '-b', 'feature/x');
  for (const entry of readdirSync(dir)) if (entry !== '.git') rmSync(join(dir, entry), { recursive: true, force: true });
  cpSync(join(ROOT, 'fixtures', 'sample-repo', 'head'), dir, { recursive: true });
  git('add', '-A');
  git('commit', '-q', '--no-verify', '-m', "Switch to banker's rounding and add invoice discounts");
  writeFileSync(join(dir, 'README.md'), '# @acme/ledger\n\nAn uncommitted edit, so the review has something to warn about.\n');
}

function userSettings(fakeClaude: string, fakeGh: string): Record<string, unknown> {
  return {
    'workbench.startupEditor': 'none',
    'workbench.tips.enabled': false,
    'workbench.secondarySideBar.defaultVisibility': 'hidden',
    'workbench.enableExperiments': false,
    'chat.disableAIFeatures': true,
    'telemetry.telemetryLevel': 'off',
    'update.mode': 'none',
    'extensions.autoCheckUpdates': false,
    'extensions.autoUpdate': false,
    'window.restoreWindows': 'none',
    'security.workspace.trust.enabled': false,
    'git.openRepositoryInParentFolders': 'never',
    // The agent path runs the fake CLI; its mode is switched per test through process.env.
    'filos.claude.path': fakeClaude,
    'filos.agentTimeoutSeconds': 60,
    // Branch reviews look their pull request up with gh, and posting runs `gh api`: never the real
    // one from a test. The fake answers a PR (acme/ledger#42) and records what it was sent.
    'filos.gh.path': fakeGh,
  };
}

async function main(): Promise<number> {
  const reexec = ensureHeadless();
  if (reexec !== undefined) return reexec;

  const arg = (name: string) => {
    const i = process.argv.indexOf(name);
    return i >= 0 ? process.argv[i + 1] : undefined;
  };
  const grep = arg('--grep') ?? process.env.FILOS_E2E_GREP;
  const vsix = arg('--vsix');
  const keep = process.env.FILOS_E2E_KEEP === '1';

  const run = mkdtempSync(join(tmpdir(), 'filos-e2e-'));
  const runtimeDir = join(run, 'xdg');
  mkdirSync(runtimeDir, { recursive: true });
  chmodSync(runtimeDir, 0o700);
  const userData = join(run, 'user-data');
  const extensionsDir = join(run, 'extensions');
  const workspace = join(run, 'ws');
  const shots = join(ROOT, '.vscode-test', 'e2e-shots');
  rmSync(shots, { recursive: true, force: true });
  mkdirSync(shots, { recursive: true });
  mkdirSync(join(userData, 'User'), { recursive: true });

  const fakeClaude = join(ROOT, 'test', 'fixtures', 'fake-claude', 'claude');
  const fakeGh = join(ROOT, 'test', 'fixtures', 'fake-gh', 'gh');
  writeFileSync(join(userData, 'User', 'settings.json'), JSON.stringify(userSettings(fakeClaude, fakeGh), null, 2));
  makeWorkspace(workspace);
  let extensionPath = ROOT;
  if (vsix) {
    // A .vsix is a zip with the extension under extension/.
    execFileSync('unzip', ['-q', resolve(vsix), '-d', join(run, 'vsix')]);
    extensionPath = join(run, 'vsix', 'extension');
  }
  scrubEnvironment(runtimeDir);
  const cdpPort = await freePort();

  const vscodeExecutablePath = existsSync(INSTALLED_VSCODE) ? INSTALLED_VSCODE : undefined;
  console.log(`Filos e2e: VS Code ${vscodeExecutablePath ?? '(downloaded)'} on DISPLAY=${process.env.DISPLAY ?? '(none)'}, extension ${extensionPath}, run dir ${run}`);
  try {
    await runTests({
      vscodeExecutablePath,
      extensionDevelopmentPath: extensionPath,
      extensionTestsPath: join(ROOT, 'dist', 'test', 'suite.js'),
      extensionTestsEnv: {
        FILOS_E2E_ROOT: ROOT,
        FILOS_E2E_WORKSPACE: workspace,
        FILOS_E2E_SHOTS: shots,
        // Real mouse and keyboard input goes in through the DevTools protocol (see cdp.ts).
        FILOS_E2E_CDP_PORT: String(cdpPort),
        FILOS_E2E_GREP: grep ?? '',
        FILOS_E2E_FAKE_CLAUDE: fakeClaude,
        FILOS_E2E_FAKE_GH: fakeGh,
        // A scratch directory of this run (removed afterwards), e.g. for the fake gh's call record.
        FILOS_E2E_RUN: run,
        FAKE_CLAUDE_MODE: 'ok',
        FAKE_CLAUDE_GRAPH: join(ROOT, 'fixtures', 'sample-graph.json'),
        // The questions task answers the sample's hand-written set, valid for the graph above.
        FAKE_CLAUDE_QUESTIONS: join(ROOT, 'fixtures', 'sample-questions.json'),
        FAKE_GH_MODE: 'ok',
      },
      launchArgs: [
        workspace,
        '--disable-extensions',
        `--user-data-dir=${userData}`,
        `--extensions-dir=${extensionsDir}`,
        '--disable-workspace-trust',
        '--skip-welcome',
        '--skip-release-notes',
        '--disable-gpu',
        // Never touch the desktop keyring from a test profile.
        '--password-store=basic',
        `--remote-debugging-port=${cdpPort}`,
      ],
    });
    console.log(`Filos e2e: passed. Screenshots in ${shots}`);
    return 0;
  } catch (e) {
    console.error(`Filos e2e: failed (${e instanceof Error ? e.message : String(e)}). Screenshots in ${shots}`);
    return 1;
  } finally {
    if (keep) console.log(`Filos e2e: kept ${run}`);
    else rmSync(run, { recursive: true, force: true });
  }
}

main().then(
  (code) => process.exit(code),
  (e: unknown) => {
    console.error(e);
    process.exit(1);
  },
);

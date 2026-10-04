// Checks, on this machine, that the permission profile Filos gives Codex really confines the
// commands Codex runs: they may read the repository under review (and Codex's own files) and
// nothing else, write nothing, and reach no network. It runs `codex sandbox`, which needs no login
// and makes no model call, with the overrides `codex exec` gets from Filos: sandboxConfig() under a
// fresh newProfileName(), for the executable locateCodex() finds, in codexChildEnv().
//
//   npm run probe:codex-sandbox
//   npx tsx scripts/probe-codex-sandbox.ts [--codex <path>] [--decoy-auth] [--skip-if-unavailable]
//
//   --codex <path>          the codex CLI (default: codex on PATH), as filos.codex.path takes it
//   --decoy-auth            when CODEX_HOME has no auth.json, put a stand-in there for the run (CI);
//                           a real auth.json is never touched, and its content is never captured
//   --skip-if-unavailable   when the sandbox can't run anything at all (a Linux runner without user
//                           namespaces, say), print why and exit 0 instead of failing
//
// The scratch folder is created under $HOME, like Filos's pull-request checkouts, and the repository
// path has a space in it, like macOS's ~/Library/Application Support. Every read that must be
// blocked also runs without the sandbox, so "blocked" means the sandbox blocked it. Writes are judged
// on the host: the file must not appear. CODEX_HOME is created if missing; the probe removes
// everything else it wrote.
// Exit code: 0 every check passed (or the run was skipped), 1 a check failed, 2 the probe couldn't run.

import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { codexChildEnv, newProfileName, sandboxConfig } from '../src/agent/codexCli';
import { locateCodex } from '../src/agent/codexInstall';
import { absolutePathEnv } from '../src/agent/exec';

const arg = (name: string) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const codexPath = arg('--codex') ?? 'codex';
const decoyAuth = process.argv.includes('--decoy-auth');
const skipIfUnavailable = process.argv.includes('--skip-if-unavailable');

/** How long a single command may take; curl gives up after 10 s. */
const COMMAND_TIMEOUT_MS = 60_000;

type Expect = 'works' | 'blocked';
type Verdict = 'PASS' | 'FAIL' | 'INCONCLUSIVE' | 'N/A';

interface Outcome {
  exitCode: number | null;
  /** First line of stderr (or the spawn error), for the table. Never stdout: it could hold a secret. */
  note: string;
  /** stdout held the check's marker (only looked for when the check has one). */
  sawMarker: boolean;
}

interface Check {
  id: string;
  what: string;
  expect: Expect;
  /** Command and arguments, run inside the sandbox (and, for `control`, without it). */
  cmd: string[];
  /** Text only the target file holds: a read worked only if stdout has it. */
  marker?: string;
  /** stdout goes nowhere, for a file that may hold a real secret (auth.json). */
  discardStdout?: boolean;
  /** Also run without the sandbox: a blocked command must work there, or the check proves nothing. */
  control?: boolean;
  /** A control that fails for reasons outside the sandbox (no network here) is INCONCLUSIVE, not FAIL. */
  controlMayFail?: boolean;
  /** For writes: the file the command tries to create, checked on the host afterwards. */
  writes?: string;
  /** Why this check doesn't apply here (then it isn't run). */
  notApplicable?: string;
}

interface Row {
  check: Check;
  sandboxed?: Outcome;
  control?: Outcome;
  verdict: Verdict;
  why: string;
}

/** Long paths the table writes short: the probe's scratch folder, then $HOME. */
const aliases: [string, string][] = [];

function firstLine(s: string): string {
  // codex warns about its PATH helpers when CODEX_HOME is a temp folder; that isn't the command's answer.
  let line = s.split('\n').map((l) => l.trim()).find((l) => l && !/^WARNING: proceeding, even though we could not create PATH aliases/.test(l)) ?? '';
  for (const [long, short] of aliases) line = line.split(long).join(short);
  return line.length > 90 ? `${line.slice(0, 89)}…` : line;
}

function run(command: string, args: string[], o: { cwd: string; env: NodeJS.ProcessEnv; marker?: string; discardStdout?: boolean }): Outcome {
  const r = spawnSync(command, args, {
    cwd: o.cwd,
    env: o.env,
    encoding: 'utf8',
    stdio: ['ignore', o.discardStdout ? 'ignore' : 'pipe', 'pipe'],
    timeout: COMMAND_TIMEOUT_MS,
    maxBuffer: 16 * 1024 * 1024,
  });
  if (r.error) return { exitCode: null, note: r.error.message, sawMarker: false };
  const stdout = typeof r.stdout === 'string' ? r.stdout : '';
  return {
    exitCode: r.status,
    note: firstLine(r.stderr ?? '') || (r.signal ? `killed by ${r.signal}` : ''),
    sawMarker: o.marker !== undefined && stdout.includes(o.marker),
  };
}

function describe(o: Outcome | undefined, c: Check): string {
  if (!o) return '-';
  const status = o.exitCode === null ? 'did not run' : `exit ${o.exitCode}`;
  const read = c.marker !== undefined && o.sawMarker ? ', file read' : '';
  return `${status}${read}${o.note ? `: ${o.note}` : ''}`;
}

/** Did the command do what it tried (read the marker, or exit 0 for the rest)? */
function succeeded(o: Outcome, c: Check): boolean {
  if (o.exitCode !== 0) return false;
  return c.marker === undefined || o.sawMarker;
}

function judge(c: Check, sandboxed: Outcome, control: Outcome | undefined): { verdict: Verdict; why: string } {
  if (c.expect === 'works') {
    return succeeded(sandboxed, c) ? { verdict: 'PASS', why: 'works in the sandbox' } : { verdict: 'FAIL', why: 'must work in the sandbox, and did not' };
  }
  if (c.writes !== undefined) {
    const landed = existsSync(c.writes);
    if (landed) return { verdict: 'FAIL', why: `the file reached the host: ${c.writes}` };
    return { verdict: 'PASS', why: sandboxed.exitCode === 0 ? 'nothing reached the host (the sandbox wrote to a throwaway copy)' : 'blocked' };
  }
  if (control && !succeeded(control, c)) {
    return c.controlMayFail
      ? { verdict: 'INCONCLUSIVE', why: 'fails without the sandbox too, so this proves nothing here' }
      : { verdict: 'FAIL', why: 'the probe is broken: the command fails without the sandbox too' };
  }
  if (succeeded(sandboxed, c) || sandboxed.sawMarker) return { verdict: 'FAIL', why: 'must be blocked, and was not' };
  return { verdict: 'PASS', why: 'blocked' };
}

function table(rows: Row[]): string {
  const head = ['Check', 'Expected', 'In the sandbox', 'Without it', 'Result'];
  const body = rows.map((r) => [
    r.check.what,
    r.check.expect,
    r.check.notApplicable ? '-' : describe(r.sandboxed, r.check),
    r.check.notApplicable ? '-' : describe(r.control, r.check),
    `${r.verdict}: ${r.why}`,
  ]);
  const widths = head.map((h, i) => Math.min(70, Math.max(h.length, ...body.map((b) => b[i].length))));
  const fmt = (cells: string[]) => cells.map((cell, i) => (i === cells.length - 1 ? cell : cell.padEnd(widths[i]))).join(' | ');
  return [fmt(head), widths.map((w, i) => (i === head.length - 1 ? '-'.repeat(Math.max(w, 6)) : '-'.repeat(w))).join('-+-'), ...body.map(fmt)].join('\n');
}

function markdownTable(rows: Row[]): string {
  const cell = (s: string) => s.replace(/\|/g, '\\|');
  return [
    '| Check | Expected | In the sandbox | Without it | Result |',
    '| --- | --- | --- | --- | --- |',
    ...rows.map((r) => `| ${cell(r.check.what)} | ${r.check.expect} | ${cell(r.check.notApplicable ? '-' : describe(r.sandboxed, r.check))} | ${cell(r.check.notApplicable ? '-' : describe(r.control, r.check))} | **${r.verdict}**: ${cell(r.why)} |`),
  ].join('\n');
}

function summary(markdown: string): void {
  const file = process.env.GITHUB_STEP_SUMMARY;
  if (!file) return;
  try {
    appendFileSync(file, `${markdown}\n`);
  } catch {
    // The step summary is a nicety.
  }
}

function main(): number {
  if (process.platform === 'win32') {
    console.error('Filos sandbox probe: Windows is not covered yet; this probe runs on Linux and macOS.');
    return 2;
  }
  // The environment Filos gives codex: no parent-session variables, no relative PATH entries.
  const env = absolutePathEnv(codexChildEnv(process.env));
  const install = locateCodex(codexPath, { env });
  if (!install) {
    console.error(`Filos sandbox probe: no codex CLI at "${codexPath}". Install it (npm install -g @openai/codex), or pass --codex <path>.`);
    return 2;
  }
  const versionText = spawnSync(install.command, ['--version'], { cwd: tmpdir(), env, encoding: 'utf8', timeout: COMMAND_TIMEOUT_MS }).stdout?.split('\n')[0].trim() || undefined;

  const tag = randomBytes(6).toString('hex');
  const home = realpathSync(homedir());
  const codexHome = process.env.CODEX_HOME?.trim() || join(home, '.codex');
  const base = realpathSync(mkdtempSync(join(home, '.filos-sandbox-probe-')));
  aliases.push([base, '<probe>'], [home, '~']);
  const cleanups: (() => void)[] = [() => rmSync(base, { recursive: true, force: true })];

  try {
    // The repository under review, and things outside it a command must not see.
    const repo = join(base, 'Application Support', 'repo');
    mkdirSync(repo, { recursive: true });
    const marker = (what: string) => `FILOS_PROBE_${what}_${tag}`;
    writeFileSync(join(repo, 'inside.txt'), `${marker('INSIDE')}\n`);
    const outside = join(base, 'outside.txt');
    writeFileSync(outside, `${marker('HOME')}\n`);
    const sibling = join(base, 'other-checkout', 'secret.txt');
    mkdirSync(dirname(sibling), { recursive: true });
    writeFileSync(sibling, `${marker('SIBLING')}\n`);
    symlinkSync(outside, join(repo, 'link-out.txt'));

    mkdirSync(codexHome, { recursive: true });
    const codexHomeFile = join(codexHome, `filos-sandbox-probe-${tag}.txt`);
    writeFileSync(codexHomeFile, `${marker('CODEXHOME')}\n`, { mode: 0o600 });
    cleanups.push(() => rmSync(codexHomeFile, { force: true }));

    const authJson = join(codexHome, 'auth.json');
    let authNote: string | undefined;
    let authKind: 'real' | 'stand-in' | 'absent' = 'real';
    if (!existsSync(authJson)) {
      authKind = decoyAuth ? 'stand-in' : 'absent';
      if (decoyAuth) {
        const decoy = `{"filos_sandbox_probe":"${marker('AUTH')}"}\n`;
        writeFileSync(authJson, decoy, { mode: 0o600, flag: 'wx' });
        cleanups.push(() => {
          // Only ever remove the stand-in this run wrote.
          if (existsSync(authJson) && readFileSync(authJson, 'utf8') === decoy) rmSync(authJson, { force: true });
        });
      } else {
        authNote = 'no auth.json here; --decoy-auth puts a stand-in there';
      }
    }

    const tmpTarget = join(realpathSync(tmpdir()), `filos-sandbox-probe-${tag}.txt`);
    cleanups.push(() => rmSync(tmpTarget, { force: true }));
    const rg = install.readable.map((d) => join(d, 'codex-path', 'rg')).find((f) => existsSync(f));

    const profile = newProfileName();
    const overrides = sandboxConfig(profile, repo, install.readable);
    const sandboxArgs = (cmd: string[]) => ['sandbox', '-P', profile, '-C', repo, ...overrides.flatMap((c) => ['-c', c]), '--', ...cmd];

    console.log('Filos Codex sandbox probe');
    console.log(`  codex      ${install.command}`);
    console.log(`  version    ${versionText ?? '(codex --version failed)'}`);
    console.log(`  platform   ${process.platform} ${process.arch}`);
    console.log(`  repo       ${repo}`);
    console.log(`  readable   ${install.readable.join(', ') || '(none)'}`);
    console.log(`  auth.json  ${authJson} (${authKind}${authKind === 'real' ? ', read with its output discarded' : ''})`);
    console.log(`  profile    ${profile}`);
    for (const c of overrides) console.log(`  -c         ${c}`);
    console.log('');

    const checks: Check[] = [
      { id: 'read-repo', what: 'read a file in the repository', expect: 'works', cmd: ['cat', join(repo, 'inside.txt')], marker: marker('INSIDE') },
      rg
        ? { id: 'search-repo', what: "search the repository with Codex's bundled rg", expect: 'works', cmd: [rg, '-n', marker('INSIDE'), repo], marker: marker('INSIDE') }
        : { id: 'search-repo', what: "search the repository with Codex's bundled rg", expect: 'works', cmd: [], notApplicable: 'no bundled rg beside this codex' },
      { id: 'read-home', what: 'read a file in $HOME, outside the repository', expect: 'blocked', cmd: ['cat', outside], marker: marker('HOME'), control: true },
      { id: 'read-sibling', what: 'read a sibling checkout next to the repository', expect: 'blocked', cmd: ['cat', sibling], marker: marker('SIBLING'), control: true },
      { id: 'read-symlink', what: 'read through a symlink out of the repository', expect: 'blocked', cmd: ['cat', join(repo, 'link-out.txt')], marker: marker('HOME'), control: true },
      { id: 'read-codex-home', what: "read a file in Codex's home (CODEX_HOME)", expect: 'blocked', cmd: ['cat', codexHomeFile], marker: marker('CODEXHOME'), control: true },
      authNote
        ? { id: 'read-auth', what: "read Codex's login, CODEX_HOME/auth.json", expect: 'blocked', cmd: [], notApplicable: authNote }
        : { id: 'read-auth', what: `read Codex's login, CODEX_HOME/auth.json${authKind === 'stand-in' ? ' (a stand-in)' : ''}`, expect: 'blocked', cmd: ['cat', authJson], discardStdout: true, control: true },
      { id: 'write-repo', what: 'create a file in the repository', expect: 'blocked', cmd: ['touch', join(repo, `written-${tag}.txt`)], writes: join(repo, `written-${tag}.txt`) },
      { id: 'write-home', what: 'create a file in $HOME', expect: 'blocked', cmd: ['touch', join(base, `written-${tag}.txt`)], writes: join(base, `written-${tag}.txt`) },
      { id: 'write-tmp', what: 'create a file in the temp folder', expect: 'blocked', cmd: ['touch', tmpTarget], writes: tmpTarget },
      { id: 'net-https', what: 'fetch https://example.com', expect: 'blocked', cmd: ['curl', '-sS', '-m', '10', 'https://example.com'], control: true, controlMayFail: true },
      { id: 'net-ip', what: 'connect to 1.1.1.1 by address (no DNS)', expect: 'blocked', cmd: ['curl', '-sS', '-m', '10', 'http://1.1.1.1/'], control: true, controlMayFail: true },
    ];

    const header = `### Filos Codex sandbox probe: ${process.platform} ${process.arch}, ${versionText ?? 'codex'}`;

    // First, whether the sandbox can run anything at all here. If it can't (no user namespaces for
    // bubblewrap, say), every "blocked" below would be meaningless.
    const trivial = run(install.command, sandboxArgs(['true']), { cwd: repo, env });
    if (trivial.exitCode !== 0) {
      const why = `codex sandbox can't run even \`true\` here (${trivial.exitCode === null ? 'did not run' : `exit ${trivial.exitCode}`}${trivial.note ? `: ${trivial.note}` : ''}).`;
      if (skipIfUnavailable) {
        console.log(`SKIPPED: ${why} This machine can't run Codex's sandbox, so the profile can't be checked here. On Linux, Codex's bubblewrap needs unprivileged user namespaces.`);
        summary(`${header}\n\nSKIPPED: ${why}\n`);
        return 0;
      }
      console.log(`FAILED: ${why}`);
      summary(`${header}\n\nFAILED: ${why}\n`);
      return 1;
    }

    const rows: Row[] = checks.map((check) => {
      if (check.notApplicable) return { check, verdict: 'N/A', why: check.notApplicable };
      const opts = { cwd: repo, env, marker: check.marker, discardStdout: check.discardStdout };
      const sandboxed = run(install.command, sandboxArgs(check.cmd), opts);
      const control = check.control ? run(check.cmd[0], check.cmd.slice(1), opts) : undefined;
      return { check, sandboxed, control, ...judge(check, sandboxed, control) };
    });

    console.log(table(rows));
    console.log('');

    const failed = rows.filter((r) => r.verdict === 'FAIL');
    const inconclusive = rows.filter((r) => r.verdict === 'INCONCLUSIVE');
    const verdictLine = failed.length
      ? `FAILED: ${failed.length} of ${rows.length} checks: ${failed.map((r) => r.check.id).join(', ')}.`
      : `PASSED: ${rows.filter((r) => r.verdict === 'PASS').length} checks passed${inconclusive.length ? `; inconclusive here: ${inconclusive.map((r) => r.check.id).join(', ')}` : ''}${rows.some((r) => r.verdict === 'N/A') ? `; not applicable: ${rows.filter((r) => r.verdict === 'N/A').map((r) => r.check.id).join(', ')}` : ''}.`;
    console.log(verdictLine);
    summary(`${header}\n\n${markdownTable(rows)}\n\n${verdictLine}\n`);
    return failed.length ? 1 : 0;
  } finally {
    for (const c of cleanups.reverse()) {
      try {
        c();
      } catch {
        // Best effort: leave the rest to the OS's temp cleanup.
      }
    }
  }
}

let code: number;
try {
  code = main();
} catch (e) {
  console.error(`Filos sandbox probe: ${e instanceof Error ? e.message : String(e)}`);
  code = 2;
}
process.exit(code);

// What behaves differently on macOS, simulated on any POSIX system: /tmp and /var/folders are
// symlinks into /private (every confinement check compares real paths), VS Code started from the
// Dock may lack /opt/homebrew/bin or ~/.local/bin on PATH, /usr/bin/git is a stub until Apple's
// Command Line Tools are installed, volumes can be case-sensitive, and the machine's name changes
// with the network.

import './vscodeStub';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { after, describe, it } from 'node:test';
import { createProvider, ProviderError } from '../../src/agent';
import { foundOffPath, offPathHint, runProcess, withCommandDir, type RunResult } from '../../src/agent/exec';
import { repoReader } from '../../src/agent/repoFiles';
import { leasesElsewhere, takeLease } from '../../src/host/checkoutLocks';
import { readDependencyIndex } from '../../src/host/depIndex';
import { describeAgentError } from '../../src/host/errors';
import * as git from '../../src/host/git';
import { ghFailure } from '../../src/host/github';
import { PrError, transferFailure } from '../../src/host/pr';
import { prUri, PullRequestFiles, PR_SCHEME } from '../../src/host/prFiles';
import { entryForPath } from '../../src/host/session';
import { FAKE_DIFF, FAKE_INDEX, FAKE_REPO } from './helpers';

// require, not import: the test replaces os.hostname on the module object itself.
const nodeOs = require('node:os') as typeof import('node:os');

const posixOnly = { skip: process.platform === 'win32' };
const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'filos-macos-')));
after(() => rmSync(scratch, { recursive: true, force: true }));
let n = 0;
const fresh = (name: string) => {
  const d = join(scratch, `${name}-${n++}`);
  mkdirSync(d, { recursive: true });
  return d;
};
function exe(path: string, text: string): string {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
  chmodSync(path, 0o755);
  return path;
}
/** Runs `body` with process.env's HOME and PATH replaced, then puts them back. */
async function withEnv<T>(vars: { HOME: string; PATH: string }, body: () => T | Promise<T>): Promise<T> {
  const before = { HOME: process.env.HOME, PATH: process.env.PATH };
  Object.assign(process.env, vars);
  try {
    return await body();
  } finally {
    for (const [k, v] of Object.entries(before)) if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}
const spawnMissing = (command: string): RunResult => ({
  exitCode: null,
  signal: null,
  stdout: '',
  stderrTail: '',
  timedOut: false,
  aborted: false,
  overflow: false,
  spawnError: Object.assign(new Error(`spawn ${command} ENOENT`), { code: 'ENOENT' }),
});

describe('an npm-installed CLI named by its full path (PATH lacks its folder)', () => {
  it("the child's PATH gets the CLI's own folder, last, so `#!/usr/bin/env node` finds the node beside it", () => {
    assert.deepEqual(withCommandDir({ PATH: '/usr/bin:/bin', HOME: '/h' }, '/opt/homebrew/bin/claude', 'darwin'), { PATH: '/usr/bin:/bin:/opt/homebrew/bin', HOME: '/h' });
    const on = { PATH: '/usr/bin:/opt/homebrew/bin' };
    assert.equal(withCommandDir(on, '/opt/homebrew/bin/claude', 'darwin'), on, 'already on PATH: the same object');
    assert.deepEqual(withCommandDir({}, '/Users/me/.nvm/versions/node/v22.1.0/bin/codex', 'darwin'), { PATH: '/usr/bin:/bin:/Users/me/.nvm/versions/node/v22.1.0/bin' }, "no PATH: execvp's default first");
    const env = { PATH: '/usr/bin' };
    assert.equal(withCommandDir(env, 'claude', 'darwin'), env, 'a bare name was found on PATH: nothing to add');
    assert.equal(withCommandDir({ Path: 'C:\\Windows' }, 'C:\\tools\\claude.exe', 'win32').Path, 'C:\\Windows', 'Windows starts .exe files, not scripts');
  });

  it('runProcess: a `#!/usr/bin/env node` script given by full path runs with the node installed beside it', posixOnly, async () => {
    const bin = fresh('npm-bin');
    exe(join(bin, 'node'), '#!/bin/sh\necho "node ran $(basename "$1")"\n');
    const cli = exe(join(bin, 'claude'), '#!/usr/bin/env node\n');
    const r = await runProcess({ command: cli, args: [], cwd: scratch, env: { PATH: '/usr/bin:/bin' }, collectStdout: true });
    assert.equal(r.exitCode, 0, r.stderrTail);
    assert.equal(r.stdout.trim(), 'node ran claude');
  });
});

describe('a CLI installed where PATH does not lead (VS Code started from the Dock)', () => {
  const home = '/Users/me';
  const lookup = (files: string[], PATH = '/usr/bin:/bin:/usr/sbin:/sbin', readDir: (d: string) => string[] = () => []) => ({
    platform: 'darwin' as const,
    env: { PATH, HOME: home },
    isFile: (p: string) => files.includes(p),
    readDir,
  });

  it('foundOffPath names the first common install folder that holds it and is not on PATH', () => {
    assert.equal(foundOffPath('claude', lookup(['/Users/me/.local/bin/claude', '/opt/homebrew/bin/claude'])), '/Users/me/.local/bin/claude');
    assert.equal(foundOffPath('claude', lookup(['/Users/me/.claude/local/claude'])), '/Users/me/.claude/local/claude', "Claude Code's older local install");
    assert.equal(foundOffPath('gh', lookup(['/opt/homebrew/bin/gh'])), '/opt/homebrew/bin/gh', 'Homebrew on Apple silicon');
    assert.equal(foundOffPath('gh', lookup(['/usr/local/bin/gh'])), '/usr/local/bin/gh', 'Homebrew on an Intel Mac');
    const nvm = (d: string) => (d === '/Users/me/.nvm/versions/node' ? ['v20.20.2', 'v22.1.0', 'v9.0.0', 'alias'] : []);
    assert.equal(foundOffPath('codex', lookup(['/Users/me/.nvm/versions/node/v20.20.2/bin/codex', '/Users/me/.nvm/versions/node/v22.1.0/bin/codex'], undefined, nvm)), '/Users/me/.nvm/versions/node/v22.1.0/bin/codex', "nvm's newest Node first");
  });

  it('foundOffPath: nothing when the folder is on PATH (then it is another problem), for a path, or on Windows', () => {
    assert.equal(foundOffPath('claude', lookup(['/opt/homebrew/bin/claude'], '/usr/bin:/opt/homebrew/bin')), undefined);
    assert.equal(foundOffPath('/opt/homebrew/bin/claude', lookup(['/opt/homebrew/bin/claude'])), undefined);
    assert.equal(foundOffPath('claude', { ...lookup(['/opt/homebrew/bin/claude']), platform: 'win32' }), undefined);
    assert.equal(foundOffPath('claude', lookup([])), undefined);
    assert.equal(offPathHint('claude', 'filos.claude.path', lookup([])), '');
    assert.equal(
      offPathHint('claude', 'filos.claude.path', lookup(['/Users/me/.local/bin/claude'])),
      " Filos found one at /Users/me/.local/bin/claude, a folder that isn't on the PATH VS Code started with: set filos.claude.path to that path.",
    );
  });

  it('Claude Code and Codex: "not found" says to set the path setting, and names where it is', posixOnly, async () => {
    const home = fresh('home');
    const claude = exe(join(home, '.local', 'bin', 'claude'), '#!/bin/sh\nexit 0\n');
    const codex = exe(join(home, '.local', 'bin', 'codex'), '#!/bin/sh\nexit 0\n');
    const env = { HOME: home, PATH: '/usr/bin:/bin' };
    const repo = realpathSync(FAKE_REPO);
    const request = { repoRoot: repo, diff: FAKE_DIFF, base: 'main', head: 'feature', prTitle: 't', dependencyIndex: FAKE_INDEX };
    for (const [p, path, setting] of [
      [createProvider({ id: 'claude', claudePath: 'claude', maxBudgetUsd: 1, timeoutSeconds: 5, env }), claude, 'filos.claude.path'],
      [createProvider({ id: 'codex', codexPath: 'codex', useUserConfig: false, timeoutSeconds: 5, env }), codex, 'filos.codex.path'],
    ] as const) {
      for (const call of [() => p.checkReady(), () => p.comprehend(request)]) {
        await assert.rejects(call(), (e: unknown) => {
          assert.ok(e instanceof ProviderError && e.kind === 'notInstalled', String(e));
          assert.ok(e.message.includes(`set ${setting}.`), e.message);
          assert.ok(e.message.includes(`Filos found one at ${path}`), e.message);
          return true;
        });
      }
    }
  });

  it("the error view and the GitHub CLI's messages name it too", posixOnly, async () => {
    const home = fresh('home');
    const claude = exe(join(home, '.local', 'bin', 'claude'), '#!/bin/sh\nexit 0\n');
    const gh = exe(join(home, '.local', 'bin', 'gh'), '#!/bin/sh\nexit 0\n');
    await withEnv({ HOME: home, PATH: '/usr/bin:/bin' }, () => {
      const view = describeAgentError(new ProviderError('notInstalled', 'Claude Code CLI not found at "claude".', 'spawn claude ENOENT'), {
        providerName: 'Claude Code',
        loginCommand: 'claude auth login',
        executable: 'claude',
        pathSetting: 'filos.claude.path',
        timeoutSeconds: 600,
      });
      assert.ok(view.detail?.includes(`Filos found one at ${claude}, a folder that isn't on the PATH VS Code started with: set filos.claude.path to that path.`), view.detail);
      const posting = ghFailure(spawnMissing('gh'), 'posting the review', 'gh');
      assert.equal(posting.kind, 'notInstalled');
      assert.ok(posting.message.includes('set "filos.gh.path".') && posting.message.includes(`Filos found one at ${gh}`), posting.message);
    });
  });
});

describe("git on a Mac without Apple's Command Line Tools", () => {
  const XCRUN = 'xcrun: error: invalid active developer path (/Library/Developer/CommandLineTools), missing xcrun at: /Library/Developer/CommandLineTools/usr/bin/xcrun\n';

  it("is read as git missing, with how to install the tools, not as a failed command (\"not a git repository\")", posixOnly, async () => {
    const bin = fresh('stub-git');
    exe(join(bin, 'git'), `#!/bin/sh\nprintf '%s' '${XCRUN}' >&2\nexit 1\n`);
    const folder = fresh('workspace');
    await withEnv({ HOME: scratch, PATH: `${bin}:/bin` }, async () => {
      await assert.rejects(git.repoRoot(folder), (e: unknown) => e instanceof git.GitError && e.code === git.GIT_NOT_FOUND && e.message === git.DEVELOPER_TOOLS_MESSAGE);
      await assert.rejects(git.git(folder, ['status']), (e: unknown) => e instanceof git.GitError && e.code === git.GIT_NOT_FOUND && /xcode-select --install/.test(e.message));
    });
  });

  it('a clone through gh that fails on it says the same', () => {
    const e = transferFailure(`Cloning into '/x'...\n${XCRUN}`, 'cloning acme/ledger', { host: 'github.com', owner: 'acme', repo: 'ledger', number: 9, baseRefName: 'main' });
    assert.ok(e instanceof PrError);
    assert.equal(e.kind, 'gitNotInstalled');
    assert.equal(e.message, git.DEVELOPER_TOOLS_MESSAGE);
    assert.equal(git.missingDeveloperTools('fatal: not a git repository (or any of the parent directories): .git'), false);
  });
});

describe('/tmp and /var/folders are symlinks into /private: confinement compares real paths', posixOnly, () => {
  // Like /var/folders/xy/T → /private/var/folders/xy/T on macOS.
  const real = fresh('private-var');
  const link = join(scratch, `var-${n++}`);
  if (process.platform !== 'win32') symlinkSync(real, link);

  it('the repo reader, through a symlinked parent: reads inside, never through a link out', () => {
    mkdirSync(join(real, 'repo', 'src'), { recursive: true });
    writeFileSync(join(real, 'repo', 'src', 'a.ts'), 'a\n');
    writeFileSync(join(real, 'secret.txt'), 'no');
    symlinkSync(join(real, 'secret.txt'), join(real, 'repo', 'leak.txt'));
    const read = repoReader(join(link, 'repo'));
    assert.equal(read('src/a.ts'), 'a\n');
    assert.equal(read('leak.txt'), undefined);
    assert.equal(read(join(link, 'repo', 'src', 'a.ts')), undefined, 'absolute paths never');
  });

  it('the dependency index, through a symlinked parent, is inside the repository', () => {
    mkdirSync(join(real, 'idx', '.filos'), { recursive: true });
    writeFileSync(join(real, 'idx', '.filos', 'dependency-index.json'), '{}');
    assert.deepEqual(readDependencyIndex(join(link, 'idx')), { text: '{}' });
  });

  it('filos-pr: files, with the storage root reached through a symlink', () => {
    const wt = join(real, 'prs', 'github.com', 'acme', 'ledger', 'worktrees', 'pr-9-0123456789ab');
    mkdirSync(join(wt, 'src'), { recursive: true });
    writeFileSync(join(wt, 'src', 'a.js'), 'x\n');
    const root = join(link, 'prs');
    const uri = prUri(root, join(wt, 'src', 'a.js'))!;
    assert.equal(uri.path, '/github.com/acme/ledger/worktrees/pr-9-0123456789ab/src/a.js');
    const fs = new PullRequestFiles(() => root);
    const asUri = { scheme: PR_SCHEME, path: uri.path } as never;
    assert.equal(Buffer.from(fs.readFile(asUri)).toString('utf8'), 'x\n');
  });

  it("Codex: -C, the cwd and the permission profile name the repository's real path, and codex's own file by its real path", async () => {
    const repoLink = join(link, 'codex-repo');
    symlinkSync(realpathSync(FAKE_REPO), repoLink);
    const binLink = join(link, 'codex-bin');
    symlinkSync(dirname(resolve(__dirname, '../fixtures/fake-codex/codex')), binLink);
    const record = join(real, 'codex-record.json');
    const p = createProvider({ id: 'codex', codexPath: join(binLink, 'codex'), useUserConfig: false, timeoutSeconds: 30, env: { FAKE_CODEX_MODE: 'ok', FAKE_CODEX_RECORD: record } });
    const res = await p.comprehend({ repoRoot: repoLink, diff: FAKE_DIFF, base: 'main', head: 'feature', prTitle: 't', dependencyIndex: FAKE_INDEX });
    assert.equal(res.graph.nodes.length, 7);
    const rec = JSON.parse(readFileSync(record, 'utf8')) as { cwd: string; flags: Record<string, unknown>; permissions: { filesystem: Record<string, string> } };
    const realRepo = realpathSync(FAKE_REPO);
    assert.equal(rec.cwd, realRepo);
    assert.equal(rec.flags['--cd'], realRepo);
    assert.deepEqual(rec.permissions.filesystem, { ':minimal': 'read', [realRepo]: 'read', [realpathSync(resolve(__dirname, '../fixtures/fake-codex/codex'))]: 'read' });
  });
});

describe('case-sensitive and case-insensitive volumes', () => {
  const outlines = new Map([
    ['/r/src/Foo.ts', 'Foo'],
    ['/r/src/foo.ts', 'foo'],
    ['/r/README.md', 'readme'],
  ]);

  it('exact path first: on a case-sensitive macOS volume Foo.ts and foo.ts are two files with their own outlines', () => {
    assert.equal(entryForPath(outlines, '/r/src/Foo.ts', 'darwin'), 'Foo');
    assert.equal(entryForPath(outlines, '/r/src/foo.ts', 'darwin'), 'foo');
    assert.equal(entryForPath(outlines, '/r/src/./foo.ts', 'darwin'), 'foo', 'normalised');
  });

  it('another case only as a fallback, and only where volumes are usually case-insensitive', () => {
    assert.equal(entryForPath(outlines, '/r/readme.MD', 'darwin'), 'readme');
    assert.equal(entryForPath(new Map([['C:\\r\\a.ts', 'a']]), 'c:\\r\\a.ts', 'win32'), 'a', 'a drive letter VS Code lower-cased');
    assert.equal(entryForPath(outlines, '/r/readme.MD', 'linux'), undefined);
    assert.equal(entryForPath(outlines, '/r/missing.ts', 'darwin'), undefined);
  });
});

describe("the machine's name changes with the network (macOS)", () => {
  it("a window's own lease stays its own: its old checkouts can still be tidied", (t) => {
    const d = fresh('leases');
    const before = takeLease(d, 'pr-1-0123456789ab');
    t.mock.method(nodeOs, 'hostname', () => 'dhcp-10-0-0-5.office.example');
    assert.equal(nodeOs.hostname(), 'dhcp-10-0-0-5.office.example');
    assert.equal(leasesElsewhere(d, 'pr-1-0123456789ab'), 0, 'taken before the change');
    const afterChange = takeLease(d, 'pr-2-0123456789ab');
    assert.equal(leasesElsewhere(d), 0, 'taken after it');
    before.release();
    afterChange.release();
  });
});

// locateCodex (src/agent/codexInstall.ts): which executable Filos starts for filos.codex.path, and
// which of Codex's own files its sandbox must be able to read. npm layouts on a real (temporary)
// file system for Linux; macOS and Windows through an injected one.

import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, describe, it } from 'node:test';
import { locateCodex } from '../../src/agent/codexInstall';

const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'filos-codex-install-')));
after(() => rmSync(scratch, { recursive: true, force: true }));

const TRIPLE = 'x86_64-unknown-linux-musl';
let n = 0;

function file(path: string, text = '', mode = 0o755): string {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
  chmodSync(path, mode);
  return path;
}

/** An npm global prefix with @openai/codex: bin/codex → lib/node_modules/@openai/codex/bin/codex.js. */
function npmPrefix(platformPackageAt: 'nested' | 'hoisted' | 'own-vendor' | 'none') {
  const prefix = join(scratch, `prefix-${n++}`);
  const pkg = join(prefix, 'lib', 'node_modules', '@openai', 'codex');
  file(join(pkg, 'package.json'), JSON.stringify({ name: '@openai/codex' }), 0o644);
  const launcher = file(join(pkg, 'bin', 'codex.js'), '#!/usr/bin/env node\n');
  mkdirSync(join(prefix, 'bin'), { recursive: true });
  symlinkSync(launcher, join(prefix, 'bin', 'codex'));
  const vendorBase = {
    nested: join(pkg, 'node_modules', '@openai', 'codex-linux-x64'),
    hoisted: join(prefix, 'lib', 'node_modules', '@openai', 'codex-linux-x64'),
    'own-vendor': pkg,
    none: undefined,
  }[platformPackageAt];
  const vendor = vendorBase && join(vendorBase, 'vendor', TRIPLE);
  if (vendor) {
    file(join(vendor, 'bin', 'codex'));
    file(join(vendor, 'codex-path', 'rg'));
  }
  return { prefix, bin: join(prefix, 'bin'), launcher, vendor };
}

const linux = (PATH: string) => ({ platform: 'linux' as const, arch: 'x64', env: { PATH } });

describe('locateCodex on Linux', () => {
  it('npm: follows bin/codex → codex.js to the platform package\'s binary; the sandbox may read its vendor folder', () => {
    const { bin, vendor } = npmPrefix('nested');
    assert.deepEqual(locateCodex('codex', linux(`/nonexistent:${bin}`)), { command: join(vendor!, 'bin', 'codex'), readable: [vendor!] });
    assert.deepEqual(locateCodex(join(bin, 'codex'), linux('')), { command: join(vendor!, 'bin', 'codex'), readable: [vendor!] }, 'an absolute path too');
  });

  it('npm: a hoisted platform package, or the package\'s own vendor folder, as the launcher finds them', () => {
    for (const at of ['hoisted', 'own-vendor'] as const) {
      const { bin, vendor } = npmPrefix(at);
      assert.deepEqual(locateCodex('codex', linux(bin)), { command: join(vendor!, 'bin', 'codex'), readable: [vendor!] }, at);
    }
  });

  it('a symlinked platform package (pnpm links it in from its store): the sandbox may read the real folder', () => {
    const { prefix, bin } = npmPrefix('none');
    const store = join(prefix, 'store', '@openai+codex-linux-x64@0.160.0', 'node_modules', '@openai', 'codex-linux-x64');
    const vendor = join(store, 'vendor', TRIPLE);
    file(join(vendor, 'bin', 'codex'));
    const link = join(prefix, 'lib', 'node_modules', '@openai', 'codex', 'node_modules', '@openai', 'codex-linux-x64');
    mkdirSync(dirname(link), { recursive: true });
    symlinkSync(store, link);
    assert.deepEqual(locateCodex('codex', linux(bin)), { command: join(link, 'vendor', TRIPLE, 'bin', 'codex'), readable: [vendor] });
  });

  it('npm without its binary: the launcher (it reports the missing package itself), nothing extra readable', () => {
    const { bin } = npmPrefix('none');
    assert.deepEqual(locateCodex('codex', linux(bin)), { command: join(bin, 'codex'), readable: [] });
  });

  it('a standalone binary: itself, by its real path; a vendored binary named directly: its vendor folder', () => {
    const real = file(join(scratch, 'opt', 'codex-0.160', 'codex-x86_64-unknown-linux-musl'));
    const bin = join(scratch, 'standalone-bin');
    mkdirSync(bin, { recursive: true });
    symlinkSync(real, join(bin, 'codex'));
    assert.deepEqual(locateCodex('codex', linux(bin)), { command: join(bin, 'codex'), readable: [real] });
    const { vendor } = npmPrefix('nested');
    assert.deepEqual(locateCodex(join(vendor!, 'bin', 'codex'), linux('')), { command: join(vendor!, 'bin', 'codex'), readable: [vendor!] });
  });

  it('never a "codex" found through an empty or relative PATH entry (the repo under review); undefined when there is none', () => {
    const repo = join(scratch, `repo-${n++}`);
    file(join(repo, 'codex'));
    file(join(repo, 'bin', 'codex'));
    const prev = process.cwd();
    process.chdir(repo);
    try {
      assert.equal(locateCodex('codex', linux(':.:bin')), undefined);
    } finally {
      process.chdir(prev);
    }
    assert.equal(locateCodex(join(scratch, 'no-such-codex'), linux('')), undefined);
  });
});

describe('locateCodex on macOS (injected file system)', () => {
  /** A file system of `files` and `links` (path → target, a file or a folder prefix); realpath follows the links. */
  function mac(o: { files: string[]; links?: Record<string, string>; arch: 'arm64' | 'x64'; PATH?: string }) {
    const links = o.links ?? {};
    const realpath = (p: string): string => {
      for (const [from, to] of Object.entries(links)) if (p === from || p.startsWith(from + '/')) return realpath(to + p.slice(from.length));
      return p;
    };
    const files = new Set(o.files.map(realpath));
    const has = (p: string) => files.has(realpath(p));
    return {
      platform: 'darwin' as const,
      arch: o.arch,
      env: { PATH: o.PATH ?? '/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin:/usr/local/bin' },
      isFile: has,
      exists: has,
      realpath,
      readText: (p: string) => (/\/node_modules\/@openai\/codex\/package\.json$/.test(realpath(p)) ? JSON.stringify({ name: '@openai/codex' }) : undefined),
    };
  }
  const npmAt = (prefix: string) => {
    const pkg = `${prefix}/lib/node_modules/@openai/codex`;
    const vendor = (pkgName: string, triple: string) => `${pkg}/node_modules/@openai/${pkgName}/vendor/${triple}`;
    return {
      pkg,
      links: { [`${prefix}/bin/codex`]: `${pkg}/bin/codex.js` },
      launcher: `${pkg}/bin/codex.js`,
      arm: vendor('codex-darwin-arm64', 'aarch64-apple-darwin'),
      intel: vendor('codex-darwin-x64', 'x86_64-apple-darwin'),
    };
  };

  it('npm with Homebrew\'s Node on Apple silicon: the aarch64-apple-darwin binary; its vendor folder readable', () => {
    const n = npmAt('/opt/homebrew');
    const o = mac({ files: [n.launcher, `${n.arm}/bin/codex`], links: n.links, arch: 'arm64' });
    assert.deepEqual(locateCodex('codex', o), { command: `${n.arm}/bin/codex`, readable: [n.arm] });
    assert.deepEqual(locateCodex('/opt/homebrew/bin/codex', o), { command: `${n.arm}/bin/codex`, readable: [n.arm] }, 'filos.codex.path set to it');
  });

  it('npm on an Intel Mac (/usr/local): the x86_64-apple-darwin binary', () => {
    const n = npmAt('/usr/local');
    const o = mac({ files: [n.launcher, `${n.intel}/bin/codex`], links: n.links, arch: 'x64' });
    assert.deepEqual(locateCodex('codex', o), { command: `${n.intel}/bin/codex`, readable: [n.intel] });
  });

  it("VS Code's Intel build on Apple silicon (Rosetta) with only the arm64 package: the arm64 binary, which macOS runs; its own architecture when both are there", () => {
    const n = npmAt('/opt/homebrew');
    assert.deepEqual(locateCodex('codex', mac({ files: [n.launcher, `${n.arm}/bin/codex`], links: n.links, arch: 'x64' })), { command: `${n.arm}/bin/codex`, readable: [n.arm] });
    assert.deepEqual(locateCodex('codex', mac({ files: [n.launcher, `${n.arm}/bin/codex`, `${n.intel}/bin/codex`], links: n.links, arch: 'x64' })), { command: `${n.intel}/bin/codex`, readable: [n.intel] });
    // Linux has no such fallback: an arm64 binary can't run on x64 there.
    assert.deepEqual(
      locateCodex('/p/bin/codex', { ...mac({ files: ['/p/lib/node_modules/@openai/codex/bin/codex.js', '/p/lib/node_modules/@openai/codex/node_modules/@openai/codex-linux-arm64/vendor/aarch64-unknown-linux-musl/bin/codex'], links: { '/p/bin/codex': '/p/lib/node_modules/@openai/codex/bin/codex.js' }, arch: 'x64' }), platform: 'linux' }),
      { command: '/p/bin/codex', readable: [] },
    );
  });

  it('a symlinked platform package (pnpm): the readable folder is its real path, which is what Seatbelt matches', () => {
    const n = npmAt('/Users/me/Library/pnpm/global/5');
    const store = '/Users/me/Library/pnpm/global/5/.pnpm/@openai+codex-darwin-arm64@0.160.0/node_modules/@openai/codex-darwin-arm64';
    const link = `${n.pkg}/node_modules/@openai/codex-darwin-arm64`;
    const o = mac({ files: [n.launcher, `${store}/vendor/aarch64-apple-darwin/bin/codex`], links: { ...n.links, [link]: store }, arch: 'arm64', PATH: '/usr/bin:/bin:/Users/me/Library/pnpm/global/5/bin' });
    assert.deepEqual(locateCodex('codex', o), { command: `${n.arm}/bin/codex`, readable: [`${store}/vendor/aarch64-apple-darwin`] });
  });

  it('Homebrew (formula or cask): /opt/homebrew/bin/codex is a link to the native binary, readable by its Cellar or Caskroom path', () => {
    const cellar = '/opt/homebrew/Cellar/codex/0.160.0/bin/codex';
    assert.deepEqual(locateCodex('codex', mac({ files: [cellar], links: { '/opt/homebrew/bin/codex': cellar }, arch: 'arm64' })), { command: '/opt/homebrew/bin/codex', readable: [cellar] });
    const cask = '/opt/homebrew/Caskroom/codex/0.160.0/codex-aarch64-apple-darwin';
    assert.deepEqual(locateCodex('codex', mac({ files: [cask], links: { '/opt/homebrew/bin/codex': cask }, arch: 'arm64' })), { command: '/opt/homebrew/bin/codex', readable: [cask] });
  });

  it('VS Code started from the Dock with a PATH that lacks /opt/homebrew/bin: not found (the message then names it, see offPathHint)', () => {
    const cellar = '/opt/homebrew/Cellar/codex/0.160.0/bin/codex';
    assert.equal(locateCodex('codex', mac({ files: [cellar], links: { '/opt/homebrew/bin/codex': cellar }, arch: 'arm64', PATH: '/usr/bin:/bin:/usr/sbin:/sbin' })), undefined);
  });
});

describe('locateCodex on Windows (injected file system)', () => {
  const npm = 'C:\\Users\\me\\AppData\\Roaming\\npm';
  const pkg = `${npm}\\node_modules\\@openai\\codex`;
  const vendor = `${pkg}\\node_modules\\@openai\\codex-win32-x64\\vendor\\x86_64-pc-windows-msvc`;
  const exe = `${vendor}\\bin\\codex.exe`;

  function win(files: string[], PATH = `C:\\Windows\\system32;${npm}`) {
    const set = new Set(files);
    return {
      platform: 'win32' as const,
      arch: 'x64',
      env: { Path: PATH, PATHEXT: '.COM;.EXE;.BAT;.CMD' },
      isFile: (p: string) => set.has(p),
      exists: (p: string) => set.has(p),
      realpath: (p: string) => p,
      readText: (p: string) => (p === `${pkg}\\package.json` ? JSON.stringify({ name: '@openai/codex' }) : undefined),
    };
  }

  it('`npm install -g @openai/codex` (codex.cmd and codex.ps1 only): the codex.exe the launcher starts', () => {
    const o = win([`${npm}\\codex.cmd`, `${npm}\\codex.ps1`, `${npm}\\codex`, exe]);
    assert.deepEqual(locateCodex('codex', o), { command: exe, readable: [vendor] });
    assert.deepEqual(locateCodex(`${npm}\\codex.cmd`, o), { command: exe, readable: [vendor] }, 'filos.codex.path set to the .cmd');
  });

  it('a launcher whose codex.exe is missing: not found (a .cmd cannot be spawned without a shell)', () => {
    assert.equal(locateCodex('codex', win([`${npm}\\codex.cmd`])), undefined);
  });

  it('a codex.exe on PATH comes before a launcher in a later folder; a relative PATH entry is never searched', () => {
    const standalone = 'C:\\tools\\codex.exe';
    assert.deepEqual(locateCodex('codex', win([standalone, `${npm}\\codex.cmd`, exe], `.;repo;C:\\tools;${npm}`)), { command: standalone, readable: [standalone] });
    assert.equal(locateCodex('codex', win(['repo\\codex.exe'], '.;repo')), undefined);
  });
});

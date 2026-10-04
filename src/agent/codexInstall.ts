// Where the codex executable Filos runs really is. Three things need it:
// - the sandbox: Filos's permission profile lets commands read only the repository, plus Codex's
//   own files, since its Linux sandbox helper re-runs the codex binary inside the sandbox and its
//   bundled rg lives beside it (checked with codex-cli 0.160.0: without them every command fails
//   with "bwrap: execvp …/codex: No such file or directory");
// - Windows: `npm install -g @openai/codex` installs only codex.cmd / codex.ps1 launchers, which
//   spawn can't start without a shell, so Filos starts the codex.exe they would start;
// - a bare name is resolved against absolute PATH entries only, never the repo (resolveCommand).
// The npm layout mirrors @openai/codex's bin/codex.js: the platform package
// @openai/codex-<os>-<arch> holds vendor/<target triple>/bin/codex[.exe] and vendor/<triple>/codex-path/rg.

import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { posix, win32 } from 'node:path';
import { resolveCommand, type CommandLookup } from './exec';

export interface CodexInstall {
  /** Absolute path to spawn: the codex executable itself, never an npm launcher. */
  command: string;
  /**
   * Codex's own files, which commands in the sandbox must be able to read: its vendor folder for an
   * npm install (the binary and its bundled tools), else the binary alone.
   */
  readable: string[];
}

export interface InstallLookup extends CommandLookup {
  arch?: string;
  exists?: (path: string) => boolean;
  realpath?: (path: string) => string;
  /** A file's text, or undefined (package.json of a candidate package root). */
  readText?: (path: string) => string | undefined;
}

/** Target triples by OS and CPU, as @openai/codex's launcher has them. */
const TRIPLES: Record<string, Record<string, string>> = {
  linux: { x64: 'x86_64-unknown-linux-musl', arm64: 'aarch64-unknown-linux-musl' },
  android: { x64: 'x86_64-unknown-linux-musl', arm64: 'aarch64-unknown-linux-musl' },
  darwin: { x64: 'x86_64-apple-darwin', arm64: 'aarch64-apple-darwin' },
  win32: { x64: 'x86_64-pc-windows-msvc', arm64: 'aarch64-pc-windows-msvc' },
};
const PLATFORM_PACKAGE: Record<string, string> = {
  'x86_64-unknown-linux-musl': 'codex-linux-x64',
  'aarch64-unknown-linux-musl': 'codex-linux-arm64',
  'x86_64-apple-darwin': 'codex-darwin-x64',
  'aarch64-apple-darwin': 'codex-darwin-arm64',
  'x86_64-pc-windows-msvc': 'codex-win32-x64',
  'aarch64-pc-windows-msvc': 'codex-win32-arm64',
};
const KNOWN_TRIPLES = new Set(Object.keys(PLATFORM_PACKAGE));

/** Launchers npm writes on Windows; spawn can't start them without a shell. */
const WINDOWS_SHIMS = ['.cmd', '.bat', '.ps1'];

/**
 * The codex executable for the configured path (a name on PATH or an absolute path), or undefined
 * when there is none. An npm launcher (bin/codex.js, or codex.cmd on Windows) is followed to the
 * executable it would start.
 */
export function locateCodex(codexPath: string, o: InstallLookup = {}): CodexInstall | undefined {
  const platform = o.platform ?? process.platform;
  const p = platform === 'win32' ? win32 : posix;
  const exists = o.exists ?? existsSync;
  const real = (f: string) => {
    try {
      return (o.realpath ?? realpathSync)(f);
    } catch {
      return f;
    }
  };
  const hasDir = platform === 'win32' ? /[\\/]/.test(codexPath) : codexPath.includes('/');
  const found = hasDir
    ? (o.isFile ?? isFile)(codexPath)
      ? codexPath
      : undefined
    : resolveCommand(codexPath, { ...o, platform, ...(platform === 'win32' ? { windowsExts: ['.com', '.exe', ...WINDOWS_SHIMS] } : {}) });
  if (!found) return undefined;

  const target = real(found);
  const ext = p.extname(target).toLowerCase();
  let packageRoot: string | undefined;
  if (platform === 'win32' && WINDOWS_SHIMS.includes(p.extname(found).toLowerCase())) {
    // %APPDATA%\npm\codex.cmd starts %APPDATA%\npm\node_modules\@openai\codex\bin\codex.js.
    packageRoot = p.join(p.dirname(found), 'node_modules', '@openai', 'codex');
  } else if (ext === '.js' || ext === '.mjs' || ext === '.cjs') {
    // …/node_modules/@openai/codex/bin/codex.js
    packageRoot = p.dirname(p.dirname(target));
  }
  if (packageRoot === undefined) return { command: found, readable: [vendorDirOf(target, p) ?? target] };

  const exe = vendorExecutable(packageRoot, { ...o, platform, exists, readText: o.readText ?? readText });
  if (exe) return { command: exe, readable: [vendorDirOf(exe, p) ?? exe] };
  // A launcher without its executable: codex.js would fail too ("Missing optional dependency").
  // A .cmd can't be started at all; a codex.js can, and then reports that itself.
  return platform === 'win32' && ext !== '.js' && ext !== '.mjs' && ext !== '.cjs' ? undefined : { command: found, readable: [] };
}

/** vendor/<triple> when `exe` is …/vendor/<triple>/bin/codex[.exe], else undefined. */
function vendorDirOf(exe: string, p: typeof posix): string | undefined {
  const bin = p.dirname(exe);
  const tripleDir = p.dirname(bin);
  return p.basename(bin) === 'bin' && KNOWN_TRIPLES.has(p.basename(tripleDir)) && p.basename(p.dirname(tripleDir)) === 'vendor' ? tripleDir : undefined;
}

/**
 * The codex executable of the npm package at `packageRoot`, found the way its launcher finds it:
 * the platform package by Node's module lookup from the package's bin folder, else the package's
 * own vendor folder.
 */
function vendorExecutable(packageRoot: string, o: InstallLookup & { platform: NodeJS.Platform; exists: (f: string) => boolean; readText: (f: string) => string | undefined }): string | undefined {
  const p = o.platform === 'win32' ? win32 : posix;
  const triple = TRIPLES[o.platform]?.[o.arch ?? process.arch];
  if (!triple) return undefined;
  const name = (() => {
    try {
      return (JSON.parse(o.readText(p.join(packageRoot, 'package.json')) ?? '{}') as { name?: unknown }).name;
    } catch {
      return undefined;
    }
  })();
  if (name !== '@openai/codex') return undefined;
  const exeName = o.platform === 'win32' ? 'codex.exe' : 'codex';
  const tail = ['vendor', triple, 'bin', exeName];
  const candidates: string[] = [];
  // require.resolve('@openai/codex-<os>-<arch>/package.json') from <packageRoot>/bin.
  for (let dir = p.join(packageRoot, 'bin'); ; dir = p.dirname(dir)) {
    const modules = p.basename(dir) === 'node_modules' ? dir : p.join(dir, 'node_modules');
    candidates.push(p.join(modules, '@openai', PLATFORM_PACKAGE[triple], ...tail));
    if (p.dirname(dir) === dir) break;
  }
  candidates.push(p.join(packageRoot, ...tail));
  return candidates.find((c) => o.exists(c));
}

function isFile(f: string): boolean {
  try {
    return statSync(f).isFile();
  } catch {
    return false;
  }
}

function readText(f: string): string | undefined {
  try {
    return readFileSync(f, 'utf8');
  } catch {
    return undefined;
  }
}

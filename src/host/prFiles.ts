// A pull request's code opens in the editor through a read-only file system of Filos's own, the
// filos-pr: scheme, never as file: URIs. The checkout is the PR author's: opened as an on-disk file
// in a trusted window, other extensions would treat it as a project and run its code. ESLint, for
// one, loads the `eslint` package it finds next to the file (a node_modules/eslint the PR committed),
// and config loaders run cspell.config.js or prettier.config.js. Tooling like that only looks at
// file: documents. The URI's path isn't the file's path on disk either ("/github.com/acme/ledger/
// worktrees/pr-9-…/src/a.ts", under Filos's storage), so a tool that reads uri.fsPath anyway
// finds nothing there.

import { readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import * as vscode from 'vscode';
import type { CodeLocation } from './session';

export const PR_SCHEME = 'filos-pr';

/** The storage root with symlinks resolved (a worktree's path is real), or as given while it doesn't exist. */
export function realRoot(root: string): string {
  try {
    return realpathSync(root);
  } catch {
    return resolve(root);
  }
}

/**
 * The parts of a path under root that the scheme serves: <host>/<owner>/<repo>/worktrees/<name>/…,
 * i.e. files inside a worktree, nothing else of Filos's storage (the clones' .git, leases).
 */
function servedParts(parts: string[]): boolean {
  return parts.length >= 5 && parts[3] === 'worktrees' && parts.every((p) => p && p !== '.' && p !== '..' && !/[\\/\0]/.test(p));
}

/** The filos-pr: URI path for a file under `root` (real path), or undefined when it isn't in a worktree there. */
export function prUriPath(root: string, absPath: string): string | undefined {
  const rel = relative(root, resolve(absPath));
  if (!rel || isAbsolute(rel) || rel.split(sep)[0] === '..') return undefined;
  const parts = rel.split(sep);
  return servedParts(parts) ? `/${parts.join('/')}` : undefined;
}

/** The path on disk a filos-pr: URI path stands for, or undefined when it isn't a worktree file under `root`. */
export function prFsPath(root: string, uriPath: string): string | undefined {
  const parts = uriPath.split('/').filter((p) => p !== '');
  if (!servedParts(parts)) return undefined;
  const abs = join(root, ...parts);
  return abs.startsWith(root + sep) ? abs : undefined;
}

/** filos-pr: URI of a file under the storage root, or undefined outside a worktree there. */
export function prUri(root: string, absPath: string): vscode.Uri | undefined {
  const path = prUriPath(realRoot(root), absPath);
  return path === undefined ? undefined : vscode.Uri.from({ scheme: PR_SCHEME, path });
}

/** Where a pull request review's files open: filos-pr: URIs for the worktrees under `root`. */
export function prCodeLocation(root: string): CodeLocation {
  return {
    uri: (p) => prUri(root, p),
    path: (u) => (u.scheme === PR_SCHEME ? prFsPath(realRoot(root), u.path) : undefined),
  };
}

const READ_ONLY = 'Pull request code is read-only in Filos: it is the pull request\'s head, in Filos\'s own checkout.';

/** Serves the files of PR worktrees under the storage root, read-only. Register with isReadonly. */
export class PullRequestFiles implements vscode.FileSystemProvider {
  // Never fires: a worktree holds one commit and Filos doesn't change it while it is in use.
  private readonly changed = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
  readonly onDidChangeFile = this.changed.event;

  constructor(private readonly root: () => string) {}

  /** The real path for a URI, confined to a worktree under the root (checkouts have no symlinks; this is the last line). */
  private path(uri: vscode.Uri): string {
    const root = realRoot(this.root());
    const p = prFsPath(root, uri.path);
    if (!p) throw vscode.FileSystemError.FileNotFound(uri);
    let real: string;
    try {
      real = realpathSync(p);
    } catch {
      throw vscode.FileSystemError.FileNotFound(uri);
    }
    if (!real.startsWith(root + sep)) throw vscode.FileSystemError.NoPermissions(uri);
    return real;
  }

  watch(): vscode.Disposable {
    return new vscode.Disposable(() => undefined);
  }

  stat(uri: vscode.Uri): vscode.FileStat {
    const p = this.path(uri);
    try {
      const st = statSync(p);
      const type = st.isDirectory() ? vscode.FileType.Directory : st.isFile() ? vscode.FileType.File : vscode.FileType.Unknown;
      return { type, ctime: st.ctimeMs, mtime: st.mtimeMs, size: st.size, permissions: vscode.FilePermission.Readonly };
    } catch {
      throw vscode.FileSystemError.FileNotFound(uri);
    }
  }

  readDirectory(uri: vscode.Uri): [string, vscode.FileType][] {
    const p = this.path(uri);
    try {
      return readdirSync(p, { withFileTypes: true }).map((d) => [d.name, d.isDirectory() ? vscode.FileType.Directory : d.isFile() ? vscode.FileType.File : vscode.FileType.Unknown]);
    } catch {
      throw vscode.FileSystemError.FileNotFound(uri);
    }
  }

  readFile(uri: vscode.Uri): Uint8Array {
    const p = this.path(uri);
    try {
      return readFileSync(p);
    } catch {
      throw vscode.FileSystemError.FileNotFound(uri);
    }
  }

  createDirectory(uri: vscode.Uri): void {
    throw vscode.FileSystemError.NoPermissions(uri);
  }

  writeFile(uri: vscode.Uri): void {
    throw vscode.FileSystemError.NoPermissions(uri);
  }

  delete(uri: vscode.Uri): void {
    throw vscode.FileSystemError.NoPermissions(uri);
  }

  rename(uri: vscode.Uri): void {
    throw vscode.FileSystemError.NoPermissions(uri);
  }

  dispose(): void {
    this.changed.dispose();
  }
}

/** Registers the scheme. The message shows when someone tries to edit a file of it. */
export function registerPullRequestFiles(root: () => string): vscode.Disposable {
  const provider = new PullRequestFiles(root);
  const message = new vscode.MarkdownString();
  message.appendText(READ_ONLY);
  return vscode.Disposable.from(provider, vscode.workspace.registerFileSystemProvider(PR_SCHEME, provider, { isCaseSensitive: process.platform === 'linux', isReadonly: message }));
}

// Pull request code in the editor: the filos-pr: file system (read-only, only worktree files under
// Filos's storage, never a path on disk that tooling could load code from), how a pull request
// session addresses its files, and where its review is stored (globalState, by URL).

import './vscodeStub';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import type * as vscode from 'vscode';
import { prCodeLocation, prFsPath, prUri, prUriPath, PullRequestFiles, PR_SCHEME } from '../../src/host/prFiles';
import { FILE_LOCATION, migrateStored, ReviewSession, storedKeys, type ReviewTarget } from '../../src/host/session';
import { MemoryMemento } from './vscodeStub';

const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'filos-prfiles-')));
after(() => rmSync(scratch, { recursive: true, force: true }));

const root = join(scratch, 'prs');
const wt = join(root, 'github.com', 'acme', 'ledger', 'worktrees', 'pr-9-0123456789ab');
mkdirSync(join(wt, 'src'), { recursive: true });
writeFileSync(join(wt, 'src', 'a.js'), 'export const a = 1;\n');
mkdirSync(join(root, 'github.com', 'acme', 'ledger', 'repo', '.git'), { recursive: true });
writeFileSync(join(root, 'github.com', 'acme', 'ledger', 'repo', '.git', 'config'), '[core]\n');
writeFileSync(join(scratch, 'outside.txt'), 'not for the editor');

const uriOf = (path: string) => ({ scheme: PR_SCHEME, path, fsPath: path, toString: () => `${PR_SCHEME}:${path}` }) as unknown as vscode.Uri;
const code = (f: () => unknown) => {
  try {
    f();
  } catch (e) {
    return (e as { code?: string }).code;
  }
  return 'no error';
};

describe('filos-pr: URIs', () => {
  it('stand for worktree files under the storage root, by their path relative to it', () => {
    const file = join(wt, 'src', 'a.js');
    assert.equal(prUriPath(root, file), '/github.com/acme/ledger/worktrees/pr-9-0123456789ab/src/a.js');
    assert.equal(prFsPath(root, '/github.com/acme/ledger/worktrees/pr-9-0123456789ab/src/a.js'), file);
    const uri = prUri(root, file)!;
    assert.equal(uri.scheme, PR_SCHEME);
    assert.equal(uri.path, '/github.com/acme/ledger/worktrees/pr-9-0123456789ab/src/a.js');
  });

  it("are not the file's path on disk: a tool that reads uri.fsPath anyway finds nothing", () => {
    const uri = prUri(root, join(wt, 'src', 'a.js'))!;
    assert.ok(!uri.path.startsWith(root), uri.path);
  });

  it('serve nothing else of the storage, and nothing outside it', () => {
    assert.equal(prUriPath(root, join(root, 'github.com', 'acme', 'ledger', 'repo', '.git', 'config')), undefined, 'the clone itself');
    assert.equal(prUriPath(root, join(scratch, 'outside.txt')), undefined);
    assert.equal(prUriPath(root, root), undefined);
    for (const p of [
      '/github.com/acme/ledger/repo/.git/config',
      '/github.com/acme/ledger/worktrees/pr-9-0123456789ab/../../repo/.git/config',
      '/github.com/acme/ledger/worktrees/../../../../outside.txt',
      '/github.com/acme/ledger/worktrees',
      '/../outside.txt',
    ]) {
      assert.equal(prFsPath(root, p), undefined, p);
    }
  });
});

describe('PullRequestFiles', () => {
  const fs = new PullRequestFiles(() => root);
  const a = uriOf('/github.com/acme/ledger/worktrees/pr-9-0123456789ab/src/a.js');

  it('reads worktree files, and says they are read-only', () => {
    assert.equal(Buffer.from(fs.readFile(a)).toString('utf8'), 'export const a = 1;\n');
    const st = fs.stat(a);
    assert.equal(st.type, 1);
    assert.equal(st.permissions, 1, 'FilePermission.Readonly');
    assert.deepEqual(fs.readDirectory(uriOf('/github.com/acme/ledger/worktrees/pr-9-0123456789ab/src')), [['a.js', 1]]);
  });

  it('never writes, deletes or renames', () => {
    assert.equal(code(() => fs.writeFile(a)), 'NoPermissions');
    assert.equal(code(() => fs.delete(a)), 'NoPermissions');
    assert.equal(code(() => fs.rename(a)), 'NoPermissions');
    assert.equal(code(() => fs.createDirectory(a)), 'NoPermissions');
  });

  it("refuses what isn't a worktree file, and a symlink out of the storage", () => {
    assert.equal(code(() => fs.readFile(uriOf('/github.com/acme/ledger/repo/.git/config'))), 'FileNotFound');
    assert.equal(code(() => fs.readFile(uriOf('/github.com/acme/ledger/worktrees/pr-9-0123456789ab/missing.js'))), 'FileNotFound');
    symlinkSync(join(scratch, 'outside.txt'), join(wt, 'link.txt'));
    assert.equal(code(() => fs.readFile(uriOf('/github.com/acme/ledger/worktrees/pr-9-0123456789ab/link.txt'))), 'NoPermissions');
  });
});

describe('a pull request session', () => {
  const target: ReviewTarget = { kind: 'pr', repoRoot: wt, base: 'main', head: 'feature', prTitle: 'x', pr: { url: 'https://github.com/acme/ledger/pull/9', host: 'github.com', owner: 'acme', repo: 'ledger', number: 9 } };

  it('opens its files as filos-pr:, and knows them only by that scheme', () => {
    const s = new ReviewSession(target, new MemoryMemento() as never, 'k', prCodeLocation(root));
    const uri = s.uriFor('src/a.js')!;
    assert.equal(uri.scheme, PR_SCHEME);
    s.load({ contractVersion: '0.1', pr: { title: 'x', base: 'main', head: 'feature' }, orientation: 'o', nodes: [], edges: [], files: [{ path: 'src/a.js', regions: [{ startLine: 1, endLine: 1, symbol: 'a', gist: 'g' }] }] } as never, 'agent', []);
    assert.ok(s.outlineFor(uri), 'the filos-pr: document has its outline (folds and gists)');
    assert.equal(s.outlineFor(FILE_LOCATION.uri(join(wt, 'src', 'a.js'))!), undefined, 'a file: URI of the same path is not part of the review');
  });

  it('is stored by URL; a review kept per workspace before moves to the global store', () => {
    const key = ReviewSession.keyFor(target);
    assert.equal(key, 'pr\u0000https://github.com/acme/ledger/pull/9');
    const workspace = new MemoryMemento();
    const global = new MemoryMemento();
    const [viewKey, reviewKey] = storedKeys(key);
    void workspace.update(viewKey, { expanded: ['money'], visited: [] });
    void workspace.update(reviewKey, { answers: { q1: 'x' } });
    void workspace.update('filos.review:other', { keep: true });
    migrateStored(key, workspace as never, global as never);
    assert.deepEqual(global.get(viewKey), { expanded: ['money'], visited: [] });
    assert.deepEqual(global.get(reviewKey), { answers: { q1: 'x' } });
    assert.deepEqual(workspace.keys(), ['filos.review:other'], 'moved, not copied; other reviews untouched');
    // Never over what the global store has already (a review opened from another window since).
    void workspace.update(reviewKey, { answers: { q1: 'old' } });
    migrateStored(key, workspace as never, global as never);
    assert.deepEqual(global.get(reviewKey), { answers: { q1: 'x' } });
    assert.equal(workspace.get(reviewKey), undefined);
    const s = new ReviewSession(target, global as never);
    assert.deepEqual(s.state, { expanded: ['money'], visited: [] }, 'the session reads it from there');
  });
});

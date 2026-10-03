// The dependency index arrives with the PR: it is read only as a plain file inside the repo, with a cap.

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { MAX_DEP_INDEX_BYTES, readDependencyIndex } from '../../src/host/depIndex';

const scratch = mkdtempSync(join(tmpdir(), 'filos-depindex-'));
after(() => rmSync(scratch, { recursive: true, force: true }));

let n = 0;
function repo(): string {
  const root = join(scratch, `repo${n++}`);
  mkdirSync(root);
  return root;
}
const posix = process.platform !== 'win32';

describe('readDependencyIndex', () => {
  it('reads a regular file, and is silent when there is none', () => {
    const root = repo();
    assert.deepEqual(readDependencyIndex(root), {});
    mkdirSync(join(root, '.filos'));
    assert.deepEqual(readDependencyIndex(root), {});
    writeFileSync(join(root, '.filos', 'dependency-index.json'), '{"symbols":[]}');
    assert.deepEqual(readDependencyIndex(root), { text: '{"symbols":[]}' });
  });

  it('ignores a symlinked index, with a warning', { skip: !posix }, () => {
    const root = repo();
    const secret = join(scratch, 'secret.txt');
    writeFileSync(secret, 'AWS_SECRET=shh');
    mkdirSync(join(root, '.filos'));
    symlinkSync(secret, join(root, '.filos', 'dependency-index.json'));
    const r = readDependencyIndex(root);
    assert.equal(r.text, undefined);
    assert.match(r.warning ?? '', /^Dependency index ignored: .*symbolic link/);
  });

  it('ignores a link to /dev/zero rather than reading forever', { skip: !posix }, () => {
    const root = repo();
    mkdirSync(join(root, '.filos'));
    symlinkSync('/dev/zero', join(root, '.filos', 'dependency-index.json'));
    assert.match(readDependencyIndex(root).warning ?? '', /ignored/);
  });

  it('ignores a symlinked .filos directory', { skip: !posix }, () => {
    const root = repo();
    const elsewhere = join(scratch, 'elsewhere');
    mkdirSync(elsewhere, { recursive: true });
    writeFileSync(join(elsewhere, 'dependency-index.json'), 'outside');
    symlinkSync(elsewhere, join(root, '.filos'));
    const r = readDependencyIndex(root);
    assert.equal(r.text, undefined);
    assert.match(r.warning ?? '', /\.filos is a symbolic link/);
  });

  it('ignores a directory in place of the file, and a file over the cap', () => {
    const root = repo();
    mkdirSync(join(root, '.filos', 'dependency-index.json'), { recursive: true });
    assert.match(readDependencyIndex(root).warning ?? '', /not a regular file/);

    const big = repo();
    mkdirSync(join(big, '.filos'));
    writeFileSync(join(big, '.filos', 'dependency-index.json'), Buffer.alloc(MAX_DEP_INDEX_BYTES + 1, 0x20));
    const r = readDependencyIndex(big);
    assert.equal(r.text, undefined);
    assert.match(r.warning ?? '', /over the 5 MB limit/);
  });
});

// The bundled sample repo: overlapping commands share one build, and the result is a clean two-commit repo.

import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { after, describe, it } from 'node:test';
import { git } from '../../src/host/git';
import { materialiseSample } from '../../src/host/sample';

const FIXTURES = resolve(__dirname, '../../fixtures');
const scratch = mkdtempSync(join(tmpdir(), 'filos-sample-'));
after(() => rmSync(scratch, { recursive: true, force: true }));

describe('materialiseSample', () => {
  it('overlapping calls share one build and leave base plus one commit', async () => {
    const storage = join(scratch, 'storage');
    const [a, b] = await Promise.all([materialiseSample(FIXTURES, storage, 'test'), materialiseSample(FIXTURES, storage, 'test')]);
    assert.equal(a, b, 'the second caller gets the first build');
    assert.ok(a.created);
    const log = await git(a.repoRoot, ['log', '--format=%s', 'HEAD'], { env: a.gitEnv });
    assert.equal(log.trim().split('\n').length, 2);
    assert.equal((await git(a.repoRoot, ['status', '--porcelain'], { env: a.gitEnv })).trim(), '');
    assert.deepEqual(readdirSync(storage).filter((e) => e.startsWith('.sample-build-')), [], 'no build dirs left behind');
    // core.worktree points at the final location, not the build dir it was made in.
    assert.equal((await git(a.repoRoot, ['config', 'core.worktree'], { env: { GIT_DIR: a.gitEnv.GIT_DIR } })).trim(), a.gitEnv.GIT_WORK_TREE);

    const again = await materialiseSample(FIXTURES, storage, 'test');
    assert.equal(again.created, false, 'an untouched copy is reused');
  });

  it('rebuilds a copy whose files were edited', async () => {
    const storage = join(scratch, 'edited');
    const first = await materialiseSample(FIXTURES, storage, 'test');
    writeFileSync(join(first.repoRoot, 'scribble.txt'), 'edit');
    const second = await materialiseSample(FIXTURES, storage, 'test');
    assert.ok(second.created);
    assert.ok(!existsSync(join(second.repoRoot, 'scribble.txt')));
  });
});

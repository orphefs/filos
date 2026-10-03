// The lock on a clone and the leases on worktrees that keep VS Code windows sharing Filos's storage
// out of each other's way: who counts as alive, taking over stale ones, and waiting.

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { acquireLock, isLive, leasesElsewhere, LOCK_FILE, takeLease, tryLock } from '../../src/host/checkoutLocks';

const scratch = mkdtempSync(join(tmpdir(), 'filos-locks-'));
after(() => rmSync(scratch, { recursive: true, force: true }));

let n = 0;
const dir = () => {
  const d = join(scratch, `d${n++}`);
  mkdirSync(d, { recursive: true });
  return d;
};
const owner = (pid: number, host = hostname()) => ({ pid, host, token: 'f'.repeat(16) });
/** A pid that is certainly not running: a process that has exited. */
function deadPid(): Promise<number> {
  const p = spawn('true');
  return new Promise((resolve) => p.on('exit', () => resolve(p.pid!)));
}
const longAgo = (file: string, ms: number) => {
  const t = new Date(Date.now() - ms);
  utimesSync(file, t, t);
};

describe('isLive', () => {
  it('a process on this machine: alive while it runs; one of ours only while we hold it', async () => {
    const now = Date.now();
    assert.equal(isLive(owner(process.ppid), now), true, 'our parent runs');
    assert.equal(isLive(owner(await deadPid()), now), false);
    assert.equal(isLive(owner(process.pid), now), false, "ours, but not held: left behind by an earlier run");
    assert.equal(isLive(owner(process.ppid), now - 7 * 60 * 60_000), false, 'not refreshed for hours: its pid was reused');
  });

  it('another machine: only its heartbeat counts; an unwritten lock is young or stale', () => {
    const now = Date.now();
    assert.equal(isLive(owner(1, 'elsewhere.example'), now - 60_000), true);
    assert.equal(isLive(owner(1, 'elsewhere.example'), now - 11 * 60_000), false);
    assert.equal(isLive(undefined, now - 1000), true);
    assert.equal(isLive(undefined, now - 20_000), false);
  });
});

describe('the clone lock', () => {
  it('is exclusive in this process too, and released', async () => {
    const d = dir();
    const a = await acquireLock(d);
    assert.equal(await tryLock(d), undefined);
    a.release();
    a.release();
    const b = await tryLock(d);
    assert.ok(b);
    b.release();
    assert.ok(!existsSync(join(d, LOCK_FILE)));
  });

  it('is taken over from a process that is gone, or one with no owner written for a while', async () => {
    const d = dir();
    writeFileSync(join(d, LOCK_FILE), JSON.stringify(owner(await deadPid())));
    const a = await tryLock(d);
    assert.ok(a, 'stale: taken over');
    a.release();
    writeFileSync(join(d, LOCK_FILE), '');
    assert.equal(await tryLock(d), undefined, 'being written right now');
    longAgo(join(d, LOCK_FILE), 60_000);
    const b = await tryLock(d);
    assert.ok(b);
    b.release();
    assert.deepEqual(readdirSync(d), [], 'nothing left over from taking them over');
  });

  it('is waited for while another live process holds it, and the wait can be cancelled', async () => {
    const d = dir();
    const other = spawn('sleep', ['60'], { stdio: 'ignore' });
    try {
      writeFileSync(join(d, LOCK_FILE), JSON.stringify(owner(other.pid!)));
      const waits: string[] = [];
      const abort = new AbortController();
      const waiting = acquireLock(d, { signal: abort.signal, onWait: (who) => waits.push(who) });
      await new Promise((r) => setTimeout(r, 300));
      assert.deepEqual(waits, ['another VS Code window']);
      abort.abort();
      await assert.rejects(waiting, (e: unknown) => e instanceof Error && e.name === 'AbortError');
      const again = acquireLock(d);
      other.kill();
      (await again).release();
    } finally {
      other.kill();
    }
  });

  it('is recreated with its folder if that was deleted meanwhile', async () => {
    const d = join(dir(), 'gone', 'base');
    const a = await acquireLock(d);
    rmSync(join(d, '..'), { recursive: true, force: true });
    a.release();
    const b = await acquireLock(d);
    assert.ok(existsSync(join(d, LOCK_FILE)));
    b.release();
  });
});

describe('leases', () => {
  it("are shared; this process's own never count against it; stale ones are deleted", async () => {
    const d = dir();
    const mine = takeLease(d, 'pr-9-aaaaaaaaaaaa');
    const mineToo = takeLease(d, 'pr-9-aaaaaaaaaaaa');
    assert.equal(leasesElsewhere(d, 'pr-9-aaaaaaaaaaaa'), 0);
    const other = spawn('sleep', ['60'], { stdio: 'ignore' });
    try {
      writeFileSync(join(d, `pr-9-aaaaaaaaaaaa@${other.pid}-x`), JSON.stringify(owner(other.pid!)));
      writeFileSync(join(d, `pr-7-bbbbbbbbbbbb@1-dead`), JSON.stringify(owner(await deadPid())));
      assert.equal(leasesElsewhere(d, 'pr-9-aaaaaaaaaaaa'), 1);
      assert.equal(leasesElsewhere(d, 'pr-7-bbbbbbbbbbbb'), 0);
      assert.ok(!existsSync(join(d, 'pr-7-bbbbbbbbbbbb@1-dead')), 'the stale one is gone');
      assert.equal(leasesElsewhere(d), 1, 'any worktree');
    } finally {
      other.kill();
    }
    mine.release();
    mineToo.release();
    assert.deepEqual(readdirSync(d).filter((f) => f.includes(`@${process.pid}-`)), [], 'released');
    assert.equal(leasesElsewhere(join(d, 'none')), 0);
    assert.match(readFileSync(join(d, readdirSync(d)[0]), 'utf8'), /"pid"/);
  });
});

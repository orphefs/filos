// Coordination between VS Code windows over Filos's pull request storage. Every window of a profile
// shares <globalStorage>/prs, but each runs its own extension host, so the in-process queue in
// pr.ts can't see the others. Two small file-based mechanisms can:
//
// - A lock per clone (<base>/.filos-lock): whoever changes the clone (clone, fetch, worktree add or
//   remove, a diff or read that fetches missing blobs) holds it. It is created exclusively, and the
//   holder refreshes its mtime while it works. A lock whose process is gone (on this machine), or
//   that hasn't been refreshed for a long while, is stale and is taken over.
// - Leases on worktrees (<base>/leases/<worktree>@<pid>-<token>): a window reviewing a worktree
//   holds one, so another window's tidying and "Delete Pull Request Checkouts" leave it alone.
//
// No vscode import: unit tests drive it directly.

import { randomBytes } from 'node:crypto';
import { closeSync, linkSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, utimesSync, writeSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';

export const LOCK_FILE = '.filos-lock';
const HEARTBEAT_MS = 30_000;
/** This machine, process alive: stale anyway after this long without a heartbeat (its pid was reused). */
const LOCAL_STALE_MS = 6 * 60 * 60_000;
/** Another machine (a shared home directory): its pid can't be checked, only the heartbeat. */
const REMOTE_STALE_MS = 10 * 60_000;
/** A lock with no readable owner yet is being written right now, unless it is older than this. */
const UNWRITTEN_STALE_MS = 10_000;
const POLL_MS = 250;

/**
 * This machine's name, read once: macOS changes it with the network (MacBook-Pro.local at home, a
 * DHCP name at the office), and a lease this process took before the change must still read as its
 * own, not as another machine's (which would keep its old checkouts from being tidied). Another
 * window that read the name before a change sees this one's locks as remote: still live while
 * they are refreshed, only taken over later after a crash.
 */
const HOST = hostname();

interface Owner {
  pid: number;
  host: string;
  token: string;
}

/** A lock or lease this process holds. release() is idempotent. */
export interface Held {
  release(): void;
}

/** Tokens of the locks and leases this process holds, and the files their heartbeat refreshes. */
const held = new Map<string, string>();
let heartbeat: NodeJS.Timeout | undefined;

function startHeartbeat(): void {
  if (heartbeat) return;
  heartbeat = setInterval(() => {
    const now = new Date();
    for (const file of held.values()) {
      try {
        utimesSync(file, now, now);
      } catch {
        // removed meanwhile (cleanup, or broken as stale): nothing to refresh
      }
    }
    if (!held.size && heartbeat) {
      clearInterval(heartbeat);
      heartbeat = undefined;
    }
  }, HEARTBEAT_MS);
  heartbeat.unref();
}

function parseOwner(text: string): Owner | undefined {
  try {
    const v = JSON.parse(text) as Partial<Owner>;
    if (typeof v.pid === 'number' && Number.isInteger(v.pid) && v.pid > 0 && typeof v.host === 'string' && typeof v.token === 'string') return { pid: v.pid, host: v.host, token: v.token };
  } catch {
    // not (yet) JSON
  }
  return undefined;
}

/** Whether a process exists. EPERM means it does, but belongs to someone else. */
export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Whether a lock or lease file (its owner and mtime) still belongs to a live holder. */
export function isLive(owner: Owner | undefined, mtimeMs: number, now = Date.now()): boolean {
  const age = now - mtimeMs;
  if (!owner) return age < UNWRITTEN_STALE_MS;
  if (owner.host !== HOST) return age < REMOTE_STALE_MS;
  // One of ours that we no longer hold was left behind (an earlier run of this extension host).
  if (owner.pid === process.pid) return held.has(owner.token);
  return pidAlive(owner.pid) && age < LOCAL_STALE_MS;
}

function newOwner(): Owner {
  return { pid: process.pid, host: HOST, token: randomBytes(8).toString('hex') };
}

/** Creates `file` with the owner in it, only if it doesn't exist. False when it does. */
function createExclusive(file: string, owner: Owner): boolean {
  let fd: number;
  try {
    fd = openSync(file, 'wx');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw e;
  }
  try {
    writeSync(fd, JSON.stringify(owner));
  } finally {
    closeSync(fd);
  }
  return true;
}

function readHolder(file: string): { text: string; owner?: Owner; mtimeMs: number } | undefined {
  try {
    const mtimeMs = statSync(file).mtimeMs;
    const text = readFileSync(file, 'utf8');
    return { text, owner: parseOwner(text), mtimeMs };
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw e;
  }
}

/**
 * Takes a stale lock out of the way. Renamed first (atomic), then checked: if what was moved isn't
 * the stale lock that was judged (another window broke it and took the lock in between), it is put
 * back with an exclusive link. Only a third window doing the same in that instant can still race.
 */
function breakStale(file: string, judged: string): void {
  const aside = `${file}.stale-${randomBytes(4).toString('hex')}`;
  try {
    renameSync(file, aside);
  } catch {
    return; // gone already: someone else broke it, or its holder released it
  }
  let moved = '';
  try {
    moved = readFileSync(aside, 'utf8');
  } catch {
    // unreadable: treat as not the one judged
  }
  if (moved !== judged) {
    try {
      linkSync(aside, file);
    } catch {
      // a newer lock is already in place: that one stands
    }
  }
  try {
    unlinkSync(aside);
  } catch {
    // already gone
  }
}

function hold(file: string, owner: Owner): Held {
  held.set(owner.token, file);
  startHeartbeat();
  let done = false;
  return {
    release() {
      if (done) return;
      done = true;
      held.delete(owner.token);
      try {
        if (parseOwner(readFileSync(file, 'utf8'))?.token === owner.token) unlinkSync(file);
      } catch {
        // gone (the whole folder was deleted, say): nothing to release
      }
    },
  };
}

function describeHolder(owner: Owner | undefined): string {
  if (owner && owner.host !== HOST) return `VS Code on ${owner.host.replace(/[^\w.-]/g, '').slice(0, 60) || 'another machine'}`;
  return 'another VS Code window';
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortError());
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError());
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function abortError(): Error {
  const e = new Error('Cancelled while waiting for another VS Code window.');
  e.name = 'AbortError';
  return e;
}

async function lock(dir: string, o: { signal?: AbortSignal; onWait?: (holder: string) => void; wait: boolean }): Promise<Held | undefined> {
  const file = join(dir, LOCK_FILE);
  let told = false;
  for (;;) {
    if (o.signal?.aborted) throw abortError();
    // Again on every try: "Delete Pull Request Checkouts" may have removed the folder meanwhile.
    mkdirSync(dir, { recursive: true });
    const owner = newOwner();
    if (createExclusive(file, owner)) return hold(file, owner);
    const seen = readHolder(file);
    if (!seen) continue; // released meanwhile
    if (!isLive(seen.owner, seen.mtimeMs)) {
      breakStale(file, seen.text);
      continue;
    }
    if (!o.wait) return undefined;
    if (!told) {
      told = true;
      o.onWait?.(describeHolder(seen.owner));
    }
    await delay(POLL_MS, o.signal);
  }
}

/**
 * The lock on the clone in `dir`, once no other window holds it. `onWait` is called once if it has
 * to wait, with who holds it ("another VS Code window"). Rejects with an AbortError when cancelled,
 * or with a file-system error.
 */
export async function acquireLock(dir: string, o: { signal?: AbortSignal; onWait?: (holder: string) => void } = {}): Promise<Held> {
  return (await lock(dir, { ...o, wait: true }))!;
}

/** The lock if nobody else holds it right now, else undefined. Never waits. */
export async function tryLock(dir: string): Promise<Held | undefined> {
  return lock(dir, { wait: false });
}

/** A lease on worktree `name`, as a file in `dir`. Never fails for another holder: leases are shared. */
export function takeLease(dir: string, name: string): Held {
  mkdirSync(dir, { recursive: true });
  const owner = newOwner();
  const file = join(dir, `${name}@${owner.pid}-${owner.token}`);
  createExclusive(file, owner);
  const h = hold(file, owner);
  return {
    release() {
      h.release();
    },
  };
}

/**
 * How many live leases other processes (or machines) hold on worktree `name`, or on any worktree
 * when `name` is undefined. This process's own leases don't count: a window may replace its own
 * checkouts. Stale leases are deleted on the way.
 */
export function leasesElsewhere(dir: string, name?: string): number {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return 0;
  }
  let n = 0;
  for (const e of entries) {
    const at = e.lastIndexOf('@');
    if (at <= 0 || (name !== undefined && e.slice(0, at) !== name)) continue;
    const file = join(dir, e);
    let seen: ReturnType<typeof readHolder>;
    try {
      seen = readHolder(file);
    } catch {
      n++; // can't tell: keep it, to be safe
      continue;
    }
    if (!seen) continue;
    if (!isLive(seen.owner, seen.mtimeMs)) {
      try {
        unlinkSync(file);
      } catch {
        // someone else tidied it
      }
      continue;
    }
    if (seen.owner && seen.owner.pid === process.pid && seen.owner.host === HOST) continue;
    n++;
  }
  return n;
}

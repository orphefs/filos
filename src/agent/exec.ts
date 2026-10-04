// Runs a CLI without a shell, with a timeout, cancellation and bounded memory.
// Agent CLIs run for minutes and may start helper processes, so we kill the whole process group.

import { spawn, type ChildProcess } from 'node:child_process';
import { accessSync, constants as fsConstants, statSync } from 'node:fs';
import { posix, win32 } from 'node:path';
import { StringDecoder } from 'node:string_decoder';

export interface RunOptions {
  command: string;
  args: readonly string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  /** Written to stdin, then stdin is closed (closed immediately when absent). */
  stdin?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Called for each complete stdout line, without the line break. Without it, stdout isn't split into lines. */
  onLine?: (line: string) => void;
  /** Keep a copy of stdout (up to maxCollectBytes) in the result. */
  collectStdout?: boolean;
  maxCollectBytes?: number;
  /** Kill the process if a single unterminated stdout line grows beyond this (only with onLine). */
  maxLineBytes?: number;
  /** Kill the process if total stdout exceeds this: a runaway, not a real answer. */
  maxStdoutBytes?: number;
  stderrTailBytes?: number;
  /** Grace period between SIGTERM and SIGKILL. */
  killGraceMs?: number;
}

export interface RunResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderrTail: string;
  timedOut: boolean;
  aborted: boolean;
  /** stdout exceeded a cap and the process was killed. */
  overflow: boolean;
  /** The process could not be started (ENOENT, EACCES...). */
  spawnError?: NodeJS.ErrnoException;
}

/**
 * A copy of `base` without the variables `drop` names (matched case-insensitively, as Windows
 * does), plus `extra`. For variables a parent agent session or a debug setup leaves behind that
 * would change how a child CLI behaves.
 */
export function scrubEnv(base: NodeJS.ProcessEnv, drop: (upperName: string) => boolean, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(base)) if (!drop(k.toUpperCase())) env[k] = v;
  return { ...env, ...extra };
}

const MiB = 1024 * 1024;
/** setTimeout fires almost at once for delays above 2^31-1 ms, so a huge timeout must be capped, not passed on. */
const MAX_TIMER_MS = 2_147_483_647;

export interface CommandLookup {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  /** Whether a candidate is a file that can be run (default: a regular file, executable on POSIX). */
  isFile?: (path: string) => boolean;
  /**
   * Windows only: the extensions to try, in order, instead of PATHEXT's .com and .exe. For finding an
   * npm launcher (codex.cmd) whose real executable Filos then starts itself.
   */
  windowsExts?: readonly string[];
}

/** What execvp searches when PATH is unset. */
const DEFAULT_POSIX_PATH = '/usr/bin:/bin';

/**
 * The executable to spawn for a command: undefined when it isn't found. A bare name is never looked
 * up relative to the child's cwd, which is often the repo under review: Windows searches the cwd
 * before PATH, and on every OS an empty or relative PATH entry ("", ".", "bin") resolves against
 * it, so a git, claude or codex committed to the repo would run instead of the real one. So we
 * search the absolute PATH entries ourselves and spawn the absolute path. A command with a
 * directory part is returned unchanged.
 */
export function resolveCommand(command: string, o: CommandLookup = {}): string | undefined {
  const env = o.env ?? process.env;
  if ((o.platform ?? process.platform) !== 'win32') {
    if (command.includes('/')) return command;
    if (!command) return undefined;
    const isExec = o.isFile ?? defaultIsExecutable;
    for (const dir of (env.PATH ?? DEFAULT_POSIX_PATH).split(':')) {
      if (!dir || !posix.isAbsolute(dir)) continue;
      const candidate = posix.join(dir, command);
      if (isExec(candidate)) return candidate;
    }
    return undefined;
  }
  if (/[\\/]/.test(command)) return command;
  const get = (name: string) => env[Object.keys(env).find((k) => k.toUpperCase() === name) ?? name];
  const isFile = o.isFile ?? defaultIsFile;
  // Only .com and .exe start without a shell (spawn refuses .cmd/.bat when shell is false).
  const runnable = (get('PATHEXT') ?? '.COM;.EXE').split(';').map((e) => e.trim().toLowerCase()).filter((e) => e === '.com' || e === '.exe');
  const exts = [...(win32.extname(command) ? [''] : []), ...(o.windowsExts ?? (runnable.length ? runnable : ['.com', '.exe']))];
  for (const dir of (get('PATH') ?? '').split(';')) {
    // '' and '.' (and any relative entry) would mean the cwd again: the repo under review.
    const d = dir.trim().replace(/^"(.*)"$/, '$1');
    if (!d || !win32.isAbsolute(d)) continue;
    for (const ext of exts) {
      const candidate = win32.join(d, command + ext);
      if (isFile(candidate)) return candidate;
    }
  }
  return undefined;
}

/**
 * `env` with PATH reduced to its absolute entries. A child that looks a program up by name (the
 * `#!/usr/bin/env node` line of an npm-installed CLI, git running a helper, an agent CLI running
 * `git`) would otherwise find one in its cwd, the repo under review, through an empty or relative
 * entry. Returns `env` itself when there is nothing to remove.
 */
export function absolutePathEnv(env: NodeJS.ProcessEnv, platform: NodeJS.Platform = process.platform): NodeJS.ProcessEnv {
  const win = platform === 'win32';
  const key = win ? Object.keys(env).find((k) => k.toUpperCase() === 'PATH') : 'PATH';
  const value = key === undefined ? undefined : env[key];
  if (key === undefined || value === undefined) return env;
  const sep = win ? ';' : ':';
  const entries = value.split(sep);
  const kept = entries.filter((e) => {
    const d = win ? e.trim().replace(/^"(.*)"$/, '$1') : e;
    return !!d && (win ? win32.isAbsolute(d) : posix.isAbsolute(d));
  });
  return kept.length === entries.length ? env : { ...env, [key]: kept.join(sep) };
}

function defaultIsFile(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

function defaultIsExecutable(p: string): boolean {
  try {
    if (!statSync(p).isFile()) return false;
    accessSync(p, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export function runProcess(o: RunOptions): Promise<RunResult> {
  const maxLine = o.maxLineBytes ?? 32 * MiB;
  const maxStdout = o.maxStdoutBytes ?? 256 * MiB;
  const maxCollect = o.maxCollectBytes ?? 4 * MiB;
  const stderrTailBytes = o.stderrTailBytes ?? 16 * 1024;
  const grace = o.killGraceMs ?? 2000;

  const result: RunResult = { exitCode: null, signal: null, stdout: '', stderrTail: '', timedOut: false, aborted: false, overflow: false };
  if (o.signal?.aborted) return Promise.resolve({ ...result, aborted: true });
  const command = resolveCommand(o.command, o.env ? { env: o.env } : {});
  if (command === undefined) {
    const err: NodeJS.ErrnoException = Object.assign(new Error(`spawn ${o.command} ENOENT`), { code: 'ENOENT', path: o.command });
    return Promise.resolve({ ...result, spawnError: err });
  }

  return new Promise((resolve) => {
    let child: ChildProcess;
    try {
      child = spawn(command, [...o.args], {
        cwd: o.cwd,
        env: absolutePathEnv(o.env ?? process.env),
        stdio: ['pipe', 'pipe', 'pipe'],
        // Own process group on POSIX, so a kill reaches helpers the CLI started.
        detached: process.platform !== 'win32',
        windowsHide: true,
        shell: false,
      });
    } catch (err) {
      resolve({ ...result, spawnError: err as NodeJS.ErrnoException });
      return;
    }

    let settled = false;
    let killTimer: NodeJS.Timeout | undefined;
    let stdoutBytes = 0;
    let collected = 0;
    let pending = '';
    let stderr = '';
    const decoder = new StringDecoder('utf8');

    const terminate = () => {
      if (killTimer) return;
      killTree(child, 'SIGTERM');
      killTimer = setTimeout(() => killTree(child, 'SIGKILL'), grace);
      killTimer.unref();
    };

    const timer = o.timeoutMs !== undefined ? setTimeout(() => ((result.timedOut = true), terminate()), Math.min(o.timeoutMs, MAX_TIMER_MS)) : undefined;
    const onAbort = () => ((result.aborted = true), terminate());
    o.signal?.addEventListener('abort', onAbort, { once: true });

    const emitLines = (text: string) => {
      pending += text;
      let nl: number;
      while ((nl = pending.indexOf('\n')) >= 0) {
        const line = pending.slice(0, nl).replace(/\r$/, '');
        pending = pending.slice(nl + 1);
        try {
          o.onLine?.(line);
        } catch {
          // A faulty line handler must not take the runner down with it.
        }
      }
      if (Buffer.byteLength(pending) > maxLine) {
        result.overflow = true;
        pending = '';
        terminate();
      }
    };

    child.stdout!.on('data', (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > maxStdout) {
        result.overflow = true;
        terminate();
        return;
      }
      const text = decoder.write(chunk);
      if (o.collectStdout && collected < maxCollect) {
        result.stdout += text;
        collected += chunk.length;
      }
      // Lines are only worth splitting for a listener; a caller that only collects (git's output,
      // which can be one huge line) would otherwise pay for re-measuring the pending line per chunk.
      if (o.onLine) emitLines(text);
    });
    child.stderr!.on('data', (chunk: Buffer) => {
      stderr = (stderr + chunk.toString('utf8')).slice(-stderrTailBytes);
    });
    // The CLI may exit before reading its prompt; that's reported through the exit code, not EPIPE.
    child.stdin!.on('error', () => {});
    // A CLI that never started (not installed) has no reader: even an empty write would raise
    // SIGPIPE, which VS Code's extension host logs as "Unexpected SIGPIPE". Close it unwritten.
    if (child.pid === undefined) child.stdin?.destroy();
    else child.stdin!.end(o.stdin ?? '');

    const finish = () => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      // A pending SIGKILL is left to fire: helpers that ignored SIGTERM may outlive the CLI itself.
      o.signal?.removeEventListener('abort', onAbort);
      const rest = decoder.end();
      if (o.collectStdout && rest && collected < maxCollect) result.stdout += rest;
      if (o.onLine) emitLines(rest);
      if (pending) {
        const last = pending;
        pending = '';
        try {
          o.onLine?.(last);
        } catch {
          // see above
        }
      }
      result.stderrTail = stderr;
      resolve(result);
    };

    child.on('error', (err: NodeJS.ErrnoException) => {
      // Spawn failures emit 'error' and may never emit 'close'.
      if (child.pid === undefined) {
        result.spawnError = err;
        finish();
      }
    });
    child.on('close', (code, sig) => {
      result.exitCode = code;
      result.signal = sig;
      finish();
    });
  });
}

function killTree(child: ChildProcess, sig: NodeJS.Signals) {
  if (child.pid === undefined) return;
  if (process.platform === 'win32') {
    spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }).on('error', () => {});
    return;
  }
  try {
    process.kill(-child.pid, sig);
  } catch {
    try {
      child.kill(sig);
    } catch {
      // Already gone.
    }
  }
}

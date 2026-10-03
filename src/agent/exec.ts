// Runs a CLI without a shell, with a timeout, cancellation and bounded memory.
// Agent CLIs run for minutes and may start helper processes, so we kill the whole process group.

import { spawn, type ChildProcess } from 'node:child_process';
import { statSync } from 'node:fs';
import { win32 } from 'node:path';
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

const MiB = 1024 * 1024;
/** setTimeout fires almost at once for delays above 2^31-1 ms, so a huge timeout must be capped, not passed on. */
const MAX_TIMER_MS = 2_147_483_647;

export interface CommandLookup {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  isFile?: (path: string) => boolean;
}

/**
 * The executable to spawn for a command. On Windows a bare name is looked up in the child's cwd
 * before PATH, so a git.exe or claude.exe committed to the repo under review would run instead of
 * the real one; there we search absolute PATH entries ourselves. Undefined means not found.
 * Elsewhere (and for anything with a directory part) the command is returned unchanged.
 */
export function resolveCommand(command: string, o: CommandLookup = {}): string | undefined {
  if ((o.platform ?? process.platform) !== 'win32' || /[\\/]/.test(command)) return command;
  const env = o.env ?? process.env;
  const get = (name: string) => env[Object.keys(env).find((k) => k.toUpperCase() === name) ?? name];
  const isFile = o.isFile ?? defaultIsFile;
  // Only .com and .exe start without a shell (spawn refuses .cmd/.bat when shell is false).
  const runnable = (get('PATHEXT') ?? '.COM;.EXE').split(';').map((e) => e.trim().toLowerCase()).filter((e) => e === '.com' || e === '.exe');
  const exts = [...(win32.extname(command) ? [''] : []), ...(runnable.length ? runnable : ['.com', '.exe'])];
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

function defaultIsFile(p: string): boolean {
  try {
    return statSync(p).isFile();
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
  const command = resolveCommand(o.command);
  if (command === undefined) {
    const err: NodeJS.ErrnoException = Object.assign(new Error(`spawn ${o.command} ENOENT`), { code: 'ENOENT', path: o.command });
    return Promise.resolve({ ...result, spawnError: err });
  }

  return new Promise((resolve) => {
    let child: ChildProcess;
    try {
      child = spawn(command, [...o.args], {
        cwd: o.cwd,
        env: o.env ?? process.env,
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
    child.stdin!.end(o.stdin ?? '');

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

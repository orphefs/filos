// A stand-in for the `vscode` module, so host code (ReviewState, ReviewSession) runs under
// node:test. Import it before anything that imports vscode. Not a test file itself (the runner
// globs *.test.ts). Notifications are recorded in `shown` instead of being displayed.

import Module from 'node:module';

export const shown: { kind: 'error' | 'warning' | 'info'; text: string }[] = [];

const message = (kind: 'error' | 'warning' | 'info') => (text: string) => {
  shown.push({ kind, text });
  return Promise.resolve(undefined);
};

const uri = (s: string, fsPath = s) => ({ scheme: s.startsWith('file:') ? 'file' : 'https', fsPath, path: fsPath, toString: () => s });

class EventEmitter<T> {
  private listeners: ((e: T) => void)[] = [];
  readonly event = (l: (e: T) => void) => {
    this.listeners.push(l);
    return { dispose: () => (this.listeners = this.listeners.filter((x) => x !== l)) };
  };
  fire(e: T): void {
    for (const l of this.listeners) l(e);
  }
  dispose(): void {
    this.listeners = [];
  }
}

class Disposable {
  constructor(private readonly done: () => void) {}
  static from(...ds: { dispose(): unknown }[]): Disposable {
    return new Disposable(() => ds.forEach((d) => d.dispose()));
  }
  dispose(): void {
    this.done();
  }
}

/** vscode.FileSystemError: `code` says which (FileNotFound, NoPermissions…). */
class FileSystemError extends Error {
  constructor(
    readonly code: string,
    what?: unknown,
  ) {
    super(`${code}: ${String(what)}`);
  }
  static FileNotFound = (what?: unknown) => new FileSystemError('FileNotFound', what);
  static NoPermissions = (what?: unknown) => new FileSystemError('NoPermissions', what);
}

const stub = {
  window: {
    withProgress: <T>(_o: unknown, task: (p: { report(v: unknown): void }, t: { isCancellationRequested: boolean; onCancellationRequested(): void }) => Promise<T>) =>
      task({ report() {} }, { isCancellationRequested: false, onCancellationRequested() {} }),
    showErrorMessage: message('error'),
    showWarningMessage: message('warning'),
    showInformationMessage: message('info'),
    showTextDocument: () => Promise.resolve(undefined),
  },
  workspace: { openTextDocument: () => Promise.resolve({}) },
  env: { clipboard: { writeText: () => Promise.resolve() }, openExternal: () => Promise.resolve(true) },
  Uri: {
    parse: (s: string) => uri(s),
    file: (p: string) => uri(`file://${p}`, p),
    from: (c: { scheme: string; path: string }) => ({ scheme: c.scheme, path: c.path, fsPath: c.path, toString: () => `${c.scheme}:${c.path}` }),
  },
  EventEmitter,
  Disposable,
  FileSystemError,
  FileType: { Unknown: 0, File: 1, Directory: 2, SymbolicLink: 64 },
  FilePermission: { Readonly: 1 },
  ProgressLocation: { SourceControl: 1, Window: 10, Notification: 15 },
  ViewColumn: { Active: -1, Beside: -2, One: 1, Two: 2, Nine: 9 },
};

type Loader = (request: string, parent: unknown, isMain: boolean) => unknown;
const mod = Module as unknown as { _load: Loader };
const original = mod._load;
mod._load = function (this: unknown, request: string, parent: unknown, isMain: boolean) {
  return request === 'vscode' ? stub : original.call(this, request, parent, isMain);
};

/** An in-memory Memento that stores JSON copies, as VS Code does. */
export class MemoryMemento {
  private readonly data = new Map<string, string>();
  keys(): readonly string[] {
    return [...this.data.keys()];
  }
  get<T>(key: string, fallback?: T): T | undefined {
    const v = this.data.get(key);
    return v === undefined ? fallback : (JSON.parse(v) as T);
  }
  update(key: string, value: unknown): Promise<void> {
    if (value === undefined) this.data.delete(key);
    else this.data.set(key, JSON.stringify(value));
    return Promise.resolve();
  }
  setKeysForSync(): void {}
}

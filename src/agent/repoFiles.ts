// Read-only access to the head revision for validating agent output. Paths come from the agent,
// so every read is confined to the repository, symlinks included.

import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, resolve, sep } from 'node:path';

/** Head-revision reader for validation, confined to the repo so a bad path can't escape it. */
export function repoReader(repoRoot: string): (path: string) => string | undefined {
  const root = realpathSync(repoRoot);
  return (p) => {
    if (isAbsolute(p)) return undefined;
    const abs = resolve(root, p);
    if (abs !== root && !abs.startsWith(root + sep)) return undefined;
    try {
      if (!existsSync(abs)) return undefined;
      const real = realpathSync(abs);
      if (!real.startsWith(root + sep)) return undefined;
      return readFileSync(real, 'utf8');
    } catch {
      return undefined;
    }
  };
}

/** Lines in a file's text, counted the way the graph validator counts them (a final newline ends the last line). */
export function lineCount(text: string): number {
  return text.replace(/\n$/, '').split('\n').length;
}

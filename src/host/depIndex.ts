// Reads the dependency index from the repo under review. The file arrives with the PR, so it is
// treated like any other untrusted input: no symlinks (it could point at ~/.aws/credentials or
// /dev/zero), nothing outside the repo, and a hard cap on how much is read.

import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync } from 'node:fs';
import { join, sep } from 'node:path';
import { diffStats } from '../agent/prompt';

export const DEP_INDEX = join('.filos', 'dependency-index.json');
export const MAX_DEP_INDEX_BYTES = 5 * 1024 * 1024;

export interface DependencyIndexRead {
  text?: string;
  /** Why an index that exists was not used; shown as a graph warning. */
  warning?: string;
}

const ignored = (reason: string): DependencyIndexRead => ({ warning: `Dependency index ignored: ${reason}` });

/** The index text, nothing when there is no index, or a warning when there is one Filos won't use. */
export function readDependencyIndex(root: string): DependencyIndexRead {
  const dir = join(root, '.filos');
  const file = join(root, DEP_INDEX);
  try {
    const dirStat = lstatOrUndefined(dir);
    if (!dirStat) return {};
    if (dirStat.isSymbolicLink()) return ignored('.filos is a symbolic link.');
    if (!dirStat.isDirectory()) return {};
    const fileStat = lstatOrUndefined(file);
    if (!fileStat) return {};
    if (fileStat.isSymbolicLink()) return ignored(`${DEP_INDEX} is a symbolic link.`);
    if (!fileStat.isFile()) return ignored(`${DEP_INDEX} is not a regular file.`);
    if (!realpathSync(file).startsWith(realpathSync(root) + sep)) return ignored(`${DEP_INDEX} resolves outside the repository.`);
    return readBounded(file);
  } catch (e) {
    return ignored(`${DEP_INDEX} could not be read (${e instanceof Error ? e.message : String(e)}).`);
  }
}

/**
 * Whether a diff adds, changes, removes or renames anything under .filos/, where the index lives.
 * A pull request that does is reviewed with the index from where it branched off, and says so.
 */
export function diffTouchesIndex(diff: string): boolean {
  const filos = (p?: string) => !!p && (p === '.filos' || p.startsWith('.filos/'));
  return diffStats(diff).some((f) => filos(f.path) || filos(f.oldPath));
}

function lstatOrUndefined(p: string) {
  try {
    return lstatSync(p);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw e;
  }
}

/** Reads at most the cap plus one byte, whatever stat says: a size can't be trusted for special files. */
function readBounded(file: string): DependencyIndexRead {
  // O_NOFOLLOW and O_NONBLOCK (POSIX only) close the gap between the lstat above and this open.
  const fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    if (!fstatSync(fd).isFile()) return ignored(`${DEP_INDEX} is not a regular file.`);
    const buf = Buffer.alloc(MAX_DEP_INDEX_BYTES + 1);
    let n = 0;
    while (n < buf.length) {
      const got = readSync(fd, buf, n, buf.length - n, null);
      if (got === 0) break;
      n += got;
    }
    if (n > MAX_DEP_INDEX_BYTES) return ignored(`${DEP_INDEX} is over the ${MAX_DEP_INDEX_BYTES / 1024 / 1024} MB limit.`);
    return { text: buf.subarray(0, n).toString('utf8') };
  } finally {
    closeSync(fd);
  }
}

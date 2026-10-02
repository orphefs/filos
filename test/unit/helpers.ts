// Shared fixtures for unit tests. Not a test file itself (the runner globs *.test.ts).

import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { ReviewGraph } from '../../src/contract/graph';

export const FAKE_DIR = resolve(__dirname, '../fixtures/fake-claude');
export const FAKE_CLAUDE = join(FAKE_DIR, 'claude');
export const FAKE_REPO = join(FAKE_DIR, 'repo');
export const FAKE_DIFF = readFileSync(join(FAKE_DIR, 'change.diff'), 'utf8');
export const FAKE_INDEX = readFileSync(join(FAKE_DIR, 'deps.txt'), 'utf8');

/** A fresh copy of the fixture graph, safe to mutate. */
export function fixtureGraph(): ReviewGraph {
  return JSON.parse(readFileSync(join(FAKE_DIR, 'graph.json'), 'utf8')) as ReviewGraph;
}

/** Reads head-revision files of the fixture repo, as the validator expects. */
export function readFixtureFile(path: string): string | undefined {
  try {
    return readFileSync(join(FAKE_REPO, path), 'utf8');
  } catch {
    return undefined;
  }
}

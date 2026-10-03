// The private confidence store on globalState: { [repoKey]: { [modulePath]: { confidence,
// lastTouched } } } under "filos.confidence.v1", and nothing else. Every read goes back to
// globalState, so two reviews (or a review reopened later) never work from a stale copy.

import type { Memento } from 'vscode';
import { CONFIDENCE_STATE_KEY, confidenceRepoKey, parseConfidenceData, scopedConfidenceStore, type ConfidenceStore } from '../review/confidence';

/** The bundled sample's package name: its confidence is kept apart from any real repo's. */
export const SAMPLE_PACKAGE = '@acme/ledger';

export function globalConfidenceStore(state: Pick<Memento, 'get' | 'update'>, repoKey: string, onError?: (e: unknown) => void): ConfidenceStore {
  const read = () => parseConfidenceData(state.get(CONFIDENCE_STATE_KEY));
  const save = (data: unknown) => {
    state.update(CONFIDENCE_STATE_KEY, data).then(undefined, (e: unknown) => onError?.(e));
  };
  return {
    get: (path) => scopedConfidenceStore(read(), repoKey, () => {}).get(path),
    set: (path, value) => scopedConfidenceStore(read(), repoKey, save).set(path, value),
  };
}

/** "sample:@acme/ledger" for the sample; else the normalised origin URL, or the repo root. */
export function repoKeyFor(kind: 'sample' | 'branch', repoRoot: string, originUrl?: string): string {
  return kind === 'sample' ? confidenceRepoKey({ sample: SAMPLE_PACKAGE, repoRoot }) : confidenceRepoKey({ originUrl, repoRoot });
}

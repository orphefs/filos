// Thin, provider-agnostic agent interface. Providers wrap a CLI (so the user's existing login,
// e.g. company SSO, is inherited) and never handle credentials themselves.

import type { ReviewGraph } from '../contract/graph';

export interface ComprehensionRequest {
  /** Absolute path of the repository (head revision checked out). */
  repoRoot: string;
  /** Unified diff base...head. */
  diff: string;
  base: string;
  head: string;
  prTitle: string;
  /** Contents of the dependency index, if one exists (symbol, consumers, producers). */
  dependencyIndex?: string;
  signal?: AbortSignal;
  onProgress?: (message: string) => void;
}

export interface ComprehensionResult {
  /** Validated graph. */
  graph: ReviewGraph;
  warnings: string[];
  costUsd?: number;
  durationMs?: number;
}

export interface AgentProvider {
  readonly id: string;
  readonly displayName: string;
  /** Cheap check that the CLI exists and is logged in. Throws a ProviderError if not. */
  checkReady(signal?: AbortSignal): Promise<void>;
  comprehend(req: ComprehensionRequest): Promise<ComprehensionResult>;
  /** Shell command the user can run to log in again, e.g. "claude auth login". For display. */
  readonly loginCommand: string;
  /** The same as an executable and arguments, so a terminal can run it without a shell parsing it. */
  readonly login: { command: string; args: readonly string[] };
}

export type ProviderErrorKind =
  | 'notInstalled' // CLI not found
  | 'authExpired' // not logged in / token refresh failed / 401
  | 'contract' // output didn't match the contract
  | 'timeout'
  | 'cancelled'
  | 'budget' // spending cap hit
  | 'failed'; // anything else

export class ProviderError extends Error {
  constructor(
    readonly kind: ProviderErrorKind,
    message: string,
    /** Raw detail for the error view (stderr tail, validation errors…). */
    readonly detail?: string,
  ) {
    super(message);
    this.name = 'ProviderError';
  }
}

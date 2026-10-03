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
  /**
   * The pull request's description, written by its author (pull request reviews only). Untrusted:
   * the prompt fences it as data and caps it (MAX_DESCRIPTION_CHARS).
   */
  prDescription?: string;
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

/** Small structured tasks beside the comprehension pass: questions, grading, drafting, threads. */
export type AgentTask = 'questions' | 'evaluate' | 'draftComments' | 'thread';

export interface AskRequest<T> {
  task: AgentTask;
  repoRoot: string;
  /** Appended to the CLI's system prompt: the task's rules and output contract. */
  system: string;
  /** The task input. Untrusted content (diff, code, answers) must be delimited as data. */
  prompt: string;
  /** JSON Schema for --json-schema (already in CLI-compatible form). */
  schema: object;
  /** none = no tools (fast, for grading/threads); read = Read/Grep/Glob in repoRoot. */
  tools: 'none' | 'read';
  /** Re-validates the structured output; providers are never trusted. */
  validate: (raw: unknown) => { ok: true; value: T; warnings: string[] } | { ok: false; errors: string[] };
  signal?: AbortSignal;
  onProgress?: (message: string) => void;
}

export interface AskResult<T> {
  value: T;
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
  /** One structured call for a small task; same error kinds as comprehend. */
  ask<T>(req: AskRequest<T>): Promise<AskResult<T>>;
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

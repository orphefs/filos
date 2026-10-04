// Provider factory. The host only talks to AgentProvider; each CLI is one case here.

import { ClaudeCliProvider } from './claudeCli';
import { CodexCliProvider } from './codexCli';
import type { AgentProvider } from './provider';

/** Settings for the Claude Code CLI (filos.claude.*). */
export interface ClaudeProviderConfig {
  id: 'claude';
  /** Executable path or name on PATH. */
  claudePath: string;
  model?: string;
  maxBudgetUsd: number;
  timeoutSeconds: number;
  /** Extra environment for the CLI process (tests use it to pick a fake CLI mode). */
  env?: Record<string, string>;
  /** Defaults to stdin; see ClaudeCliOptions.promptVia. */
  promptVia?: 'stdin' | 'argv';
  /** Raw CLI output lines, e.g. for an output channel. */
  onRawLine?: (line: string) => void;
}

/** Settings for the OpenAI Codex CLI (filos.codex.*). Codex reports no dollar cost, so there is no budget. */
export interface CodexProviderConfig {
  id: 'codex';
  /** Executable path or name on PATH. */
  codexPath: string;
  /** Passed as -m; empty or undefined means Codex's default model for the account. */
  model?: string;
  /** Load ~/.codex/config.toml (filos.codex.useUserConfig). The read-only lockdown applies either way. */
  useUserConfig: boolean;
  timeoutSeconds: number;
  /** Extra environment for the CLI process (tests use it to pick a fake CLI mode). */
  env?: Record<string, string>;
  /** Raw CLI output lines (codex exec --json events), e.g. for an output channel. */
  onRawLine?: (line: string) => void;
}

export type ProviderConfig = ClaudeProviderConfig | CodexProviderConfig;

export const DEFAULT_TIMEOUT_SECONDS = 600;
export const MAX_TIMEOUT_SECONDS = 3600;
export const DEFAULT_BUDGET_USD = 1;

/** A timeout of 0, a negative one or a non-number means the default, never "kill at once"; capped at an hour. */
export function effectiveTimeoutSeconds(v: unknown): number {
  if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) return DEFAULT_TIMEOUT_SECONDS;
  return Math.min(v, MAX_TIMEOUT_SECONDS);
}

/** The spending cap must be a positive amount; anything else means the default. */
export function effectiveBudgetUsd(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : DEFAULT_BUDGET_USD;
}

export function createProvider(cfg: ProviderConfig): AgentProvider {
  switch (cfg.id) {
    case 'claude':
      return new ClaudeCliProvider({
        claudePath: cfg.claudePath || 'claude',
        model: cfg.model || undefined,
        maxBudgetUsd: effectiveBudgetUsd(cfg.maxBudgetUsd),
        timeoutSeconds: effectiveTimeoutSeconds(cfg.timeoutSeconds),
        env: cfg.env,
        promptVia: cfg.promptVia,
        onRawLine: cfg.onRawLine,
      });
    case 'codex':
      return new CodexCliProvider({
        codexPath: cfg.codexPath || 'codex',
        model: cfg.model?.trim() || undefined,
        // Only an explicit true loads the user's config: anything else keeps Codex to its defaults.
        useUserConfig: cfg.useUserConfig === true,
        timeoutSeconds: effectiveTimeoutSeconds(cfg.timeoutSeconds),
        env: cfg.env,
        onRawLine: cfg.onRawLine,
      });
    default: {
      const id: never = cfg;
      throw new Error(`unknown agent provider "${String((id as { id?: unknown }).id)}"`);
    }
  }
}

export * from './provider';

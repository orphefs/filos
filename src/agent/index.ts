// Provider factory. The host only talks to AgentProvider; adding Codex later means one more case here.

import { ClaudeCliProvider } from './claudeCli';
import type { AgentProvider } from './provider';

export interface ProviderConfig {
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
    default: {
      const id: never = cfg.id;
      throw new Error(`unknown agent provider "${String(id)}"`);
    }
  }
}

export * from './provider';

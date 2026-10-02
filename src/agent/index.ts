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

export function createProvider(cfg: ProviderConfig): AgentProvider {
  switch (cfg.id) {
    case 'claude':
      return new ClaudeCliProvider({
        claudePath: cfg.claudePath || 'claude',
        model: cfg.model || undefined,
        maxBudgetUsd: cfg.maxBudgetUsd,
        timeoutSeconds: cfg.timeoutSeconds,
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

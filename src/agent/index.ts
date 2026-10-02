// Provider factory. The host only talks to AgentProvider; adding Codex later means one more case here.

import type { AgentProvider } from './provider';

export interface ProviderConfig {
  id: 'claude';
  /** Executable path or name on PATH. */
  claudePath: string;
  model?: string;
  maxBudgetUsd: number;
  timeoutSeconds: number;
}

export function createProvider(cfg: ProviderConfig): AgentProvider {
  throw new Error(`provider "${cfg.id}" not implemented yet`);
}

export * from './provider';

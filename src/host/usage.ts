// What one agent call used, for the Filos log: Claude Code reports dollars, Codex reports tokens
// (and no dollar cost on a ChatGPT plan). No vscode import.

import type { TokenUsage } from '../agent';

const count = (n: number) => (Number.isFinite(n) ? Math.round(n).toLocaleString('en-US') : '?');

/** ", $0.012" or ", 12,345 tokens in (8,000 cached), 456 out", or "" when the CLI reported neither. */
export function usageNote(r: { costUsd?: number; tokens?: TokenUsage }): string {
  const parts: string[] = [];
  if (typeof r.costUsd === 'number' && Number.isFinite(r.costUsd)) parts.push(`$${r.costUsd.toFixed(3)}`);
  const t = r.tokens;
  if (t) parts.push(`${count(t.inputTokens)} tokens in${t.cachedInputTokens ? ` (${count(t.cachedInputTokens)} cached)` : ''}, ${count(t.outputTokens)} out`);
  return parts.length ? `, ${parts.join(', ')}` : '';
}

// Turns a failed agent run into what the error view shows: a plain sentence, the raw detail, and
// the actions that can actually fix it. Kept free of vscode imports so it stays easy to test.

import type { ProviderConfig } from '../agent';
import { offPathHint } from '../agent/exec';
import { ProviderError, type AgentProvider } from '../agent/provider';
import type { ErrorAction } from '../protocol';

export interface ErrorView {
  message: string;
  detail?: string;
  actions: ErrorAction[];
}

export interface ErrorContext {
  providerName: string;
  loginCommand: string;
  /** The executable Filos ran, as configured. */
  executable: string;
  /** The setting that names it, e.g. "filos.codex.path". */
  pathSetting: string;
  timeoutSeconds: number;
  /** Claude Code only: Codex has no dollar cap (the timeout bounds it). */
  maxBudgetUsd?: number;
}

/** The error context for a run of `provider` with settings `cfg`. */
export function errorContext(provider: Pick<AgentProvider, 'displayName' | 'loginCommand'>, cfg: ProviderConfig): ErrorContext {
  const base = { providerName: provider.displayName, loginCommand: provider.loginCommand, timeoutSeconds: cfg.timeoutSeconds };
  return cfg.id === 'codex'
    ? { ...base, executable: cfg.codexPath, pathSetting: 'filos.codex.path' }
    : { ...base, executable: cfg.claudePath, pathSetting: 'filos.claude.path', maxBudgetUsd: cfg.maxBudgetUsd };
}

const join = (...parts: (string | undefined)[]) => parts.filter((p) => p && p.trim()).join('\n\n') || undefined;

export function describeAgentError(e: unknown, ctx: ErrorContext): ErrorView {
  const fallback: ErrorAction[] = ['retry', 'useFixture'];
  if (!(e instanceof ProviderError)) {
    const text = e instanceof Error ? (e.stack ?? e.message) : String(e);
    return { message: `Something went wrong while running ${ctx.providerName}.`, detail: text, actions: fallback };
  }
  const raw = e.detail && e.detail !== e.message ? e.detail : undefined;
  switch (e.kind) {
    case 'authExpired':
      return {
        message: `Your ${ctx.providerName} session has expired.`,
        detail: join(`Sign in again by running \`${ctx.loginCommand}\` in a terminal (Filos can open one for you), then retry. Filos never sees your credentials.`, e.message, raw),
        actions: ['login', 'retry', 'useFixture'],
      };
    case 'notInstalled':
      return {
        message: `Filos can't find the ${ctx.providerName} CLI.`,
        detail: join(
          `Filos runs the ${ctx.providerName} CLI so the review uses your existing login. Install it, or set the setting "${ctx.pathSetting}" to the full path of the executable (it is "${ctx.executable}" now).${offPathHint(ctx.executable, ctx.pathSetting)}`,
          raw,
        ),
        // Another CLI may be installed already (Claude Code or Codex): one click switches to it.
        actions: ['retry', 'chooseAgent', 'useFixture'],
      };
    case 'contract':
      return { message: "The agent's answer didn't match the review-graph contract.", detail: join(e.message, raw), actions: fallback };
    case 'timeout':
      return {
        message: `${ctx.providerName} didn't finish within ${ctx.timeoutSeconds} seconds.`,
        detail: join('Large changes take longer. Raise the setting "filos.agentTimeoutSeconds" and retry.', raw),
        actions: fallback,
      };
    case 'cancelled':
      return { message: 'The review was cancelled.', actions: fallback };
    case 'budget':
      return ctx.maxBudgetUsd !== undefined
        ? {
            message: `${ctx.providerName} reached the spending cap ($${ctx.maxBudgetUsd}) before finishing.`,
            detail: join('Raise the setting "filos.claude.maxBudgetUsd" to allow a longer pass, or review a smaller change.', raw),
            actions: fallback,
          }
        : { message: `${ctx.providerName} reached a usage limit before finishing.`, detail: join(e.message, raw), actions: fallback };
    case 'failed':
    default:
      return { message: e.message, detail: raw, actions: fallback };
  }
}

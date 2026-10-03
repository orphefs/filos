// Settings that choose what Filos runs and how much it may spend. They come from user settings
// only: a workspace's .vscode/settings.json arrives with the branch under review, so its values are
// ignored here even on hosts that don't enforce the settings' machine scope.

import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import * as vscode from 'vscode';
import { effectiveBudgetUsd, effectiveTimeoutSeconds, type ProviderConfig } from '../agent';

/** A user-level value (or the default), never the workspace's. */
function userSetting<T>(key: string): T | undefined {
  const i = vscode.workspace.getConfiguration('filos').inspect<T>(key);
  return i?.globalValue ?? i?.defaultValue;
}

export function readProviderConfig(): ProviderConfig {
  const id = vscode.workspace.getConfiguration('filos').get<string>('provider', 'claude');
  const model = userSetting<unknown>('claude.model');
  return {
    id: id as ProviderConfig['id'],
    claudePath: resolveExecutable(String(userSetting<unknown>('claude.path') ?? 'claude'), 'claude', 'filos.claude.path'),
    model: typeof model === 'string' && model ? model : undefined,
    maxBudgetUsd: effectiveBudgetUsd(userSetting<unknown>('claude.maxBudgetUsd')),
    timeoutSeconds: effectiveTimeoutSeconds(userSetting<unknown>('agentTimeoutSeconds')),
  };
}

/** The GitHub CLI Filos posts reviews with. Throws for a relative path, like the claude path. */
export function readGhPath(): string {
  return resolveExecutable(String(userSetting<unknown>('gh.path') ?? 'gh'), 'gh', 'filos.gh.path');
}

/** A name on PATH, an absolute path, or "~/…". A relative path would depend on some cwd, so it is refused. */
export function resolveExecutable(p: string, fallback: string, setting: string): string {
  const v = p.trim() || fallback;
  if (v === '~' || v.startsWith('~/') || v.startsWith('~\\')) return join(homedir(), v.slice(1));
  if (isAbsolute(v) || !/[\\/]/.test(v)) return v;
  throw new Error(`the setting "${setting}" must be a command name on PATH, an absolute path, or start with ~/ ("${v}" is a relative path).`);
}

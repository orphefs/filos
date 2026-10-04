// Settings that choose what Filos runs and how much it may spend. They come from user settings
// only: a workspace's .vscode/settings.json arrives with the branch under review, so its values are
// ignored here even on hosts that don't enforce the settings' machine scope.

import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import * as vscode from 'vscode';
import { effectiveBudgetUsd, effectiveTimeoutSeconds, type ProviderConfig } from '../agent';

/** The agent CLIs Filos can run (filos.provider), in the order the agent picker lists them. */
export type ProviderId = ProviderConfig['id'];
export const PROVIDER_IDS: readonly ProviderId[] = ['claude', 'codex'];

/**
 * What to call a provider when none can be built (a bad path setting, say). Elsewhere the
 * provider's own displayName is used.
 */
export const PROVIDER_NAMES: Readonly<Record<ProviderId, string>> = { claude: 'Claude Code', codex: 'Codex' };

/** A user-level value (or the default), never the workspace's. */
function userSetting<T>(key: string): T | undefined {
  const i = vscode.workspace.getConfiguration('filos').inspect<T>(key);
  return i?.globalValue ?? i?.defaultValue;
}

/** filos.provider from user settings; anything but a known id means the default, Claude Code. */
export function readProviderId(): ProviderId {
  const v = userSetting<unknown>('provider');
  return PROVIDER_IDS.find((id) => id === v) ?? 'claude';
}

/** The settings of provider `id` (by default the chosen one). Throws when a setting is invalid. */
export function readProviderConfig(id: ProviderId = readProviderId()): ProviderConfig {
  const timeoutSeconds = effectiveTimeoutSeconds(userSetting<unknown>('agentTimeoutSeconds'));
  if (id === 'codex') {
    return {
      id: 'codex',
      codexPath: resolveExecutable(String(userSetting<unknown>('codex.path') ?? 'codex'), 'codex', 'filos.codex.path'),
      model: modelSetting('codex.model'),
      useUserConfig: userSetting<unknown>('codex.useUserConfig') === true,
      timeoutSeconds,
    };
  }
  return {
    id: 'claude',
    claudePath: resolveExecutable(String(userSetting<unknown>('claude.path') ?? 'claude'), 'claude', 'filos.claude.path'),
    model: modelSetting('claude.model'),
    maxBudgetUsd: effectiveBudgetUsd(userSetting<unknown>('claude.maxBudgetUsd')),
    timeoutSeconds,
  };
}

/** The setting that names provider `id`'s executable, for messages ("set filos.codex.path"). */
export function pathSettingOf(id: ProviderId): string {
  return `filos.${id}.path`;
}

/** The executable a provider config runs. */
export function executableOf(cfg: ProviderConfig): string {
  return cfg.id === 'codex' ? cfg.codexPath : cfg.claudePath;
}

/**
 * A model name, or undefined for the CLI's default. It goes into the CLI's arguments, so a value
 * that could read as an option ("-…") or spans several words is refused rather than passed on.
 */
function modelSetting(key: string): string | undefined {
  const v = userSetting<unknown>(key);
  if (typeof v !== 'string' || !v.trim()) return undefined;
  const model = v.trim();
  if (model.startsWith('-') || /[\s\x00-\x1f\x7f]/.test(model)) {
    throw new Error(`the setting "filos.${key}" must be a model name, or empty for the CLI's default ("${model.slice(0, 80)}" is not one).`);
  }
  return model;
}

/** The GitHub CLI Filos posts reviews with. Throws for a relative path, like the agent CLIs' paths. */
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

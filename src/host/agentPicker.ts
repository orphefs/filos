// "Filos: Choose Agent CLI…": a quick pick of the agent CLIs Filos can run (Claude Code, Codex),
// each with what Filos found out about it from the current settings: installed, logged in. The
// checks run in parallel with a short timeout while the list is already up. The choice is written
// to the user setting filos.provider (never the workspace's, which a branch under review can carry).

import * as vscode from 'vscode';
import { createProvider, ProviderError, type AgentProvider } from '../agent';
import { foundOffPath } from '../agent/exec';
import { safeProgressText } from '../agent/progress';
import { executableOf, pathSettingOf, PROVIDER_IDS, PROVIDER_NAMES, readProviderConfig, readProviderId, type ProviderId } from './config';

/** How long one CLI may take to say whether it is installed and logged in. */
export const CHECK_TIMEOUT_MS = 8000;

export type AgentStatus =
  | { kind: 'checking' }
  | { kind: 'ready' }
  | { kind: 'notInstalled' }
  | { kind: 'loggedOut' }
  /** The settings for it are invalid (a relative path, say): nothing was run. */
  | { kind: 'badSettings'; reason: string }
  /** It ran, but its answer didn't settle the matter (a timeout, an older CLI, a crash). */
  | { kind: 'unknown'; reason: string };

/** What checkReady's outcome says about a CLI. `e` undefined: it succeeded. */
export function readinessOf(e: unknown, timedOut = false): AgentStatus {
  if (e === undefined) return { kind: 'ready' };
  if (timedOut) return { kind: 'unknown', reason: `no answer within ${Math.round(CHECK_TIMEOUT_MS / 1000)} seconds` };
  if (e instanceof ProviderError) {
    if (e.kind === 'notInstalled') return { kind: 'notInstalled' };
    if (e.kind === 'authExpired') return { kind: 'loggedOut' };
    return { kind: 'unknown', reason: safeProgressText(e.message, 120) };
  }
  return { kind: 'unknown', reason: safeProgressText(e instanceof Error ? e.message : String(e), 120) };
}

/** The line under a CLI's name in the picker. Codicons carry the state, and so do the words. */
export function statusLine(status: AgentStatus, pathSetting: string): string {
  switch (status.kind) {
    case 'checking':
      return '$(loading~spin) Checking…';
    case 'ready':
      return '$(pass) Installed and logged in';
    case 'loggedOut':
      return '$(warning) Installed, not logged in';
    case 'notInstalled':
      return `$(error) Not found. Install it, or set ${pathSetting}`;
    case 'badSettings':
      return `$(error) ${plain(status.reason)}`;
    case 'unknown':
      return `$(question) Couldn't check: ${plain(status.reason)}`;
  }
}

interface Candidate {
  id: ProviderId;
  name: string;
  executable?: string;
  provider?: AgentProvider;
  status: AgentStatus;
}

interface AgentItem extends vscode.QuickPickItem {
  id: ProviderId;
}

/** Text shown in a quick pick (which draws "$(icon)" but no links): one line, no icons, bounded. */
function plain(text: string, max = 160): string {
  const flat = text.replace(/\$/g, '').replace(/[\s\x00-\x1f\x7f]+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat;
}

/** Text shown in a notification, which turns [label](command:…) into a link: no link syntax, bounded. */
const notice = (text: string, max = 200) => safeProgressText(text, max);

/** Runs checkReady with the short timeout; never rejects. */
async function check(provider: AgentProvider, abort: AbortSignal): Promise<AgentStatus> {
  const own = new AbortController();
  const stop = () => own.abort();
  abort.addEventListener('abort', stop, { once: true });
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  // A CLI that ignores the abort still can't hold the picker: the race ends at the timeout.
  const timeout = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => {
      timedOut = true;
      own.abort();
      resolve('timeout');
    }, CHECK_TIMEOUT_MS);
  });
  try {
    const outcome = await Promise.race([provider.checkReady(own.signal).then(() => undefined, (e: unknown) => e ?? new Error('check failed')), timeout]);
    return outcome === 'timeout' ? readinessOf(new Error('timeout'), true) : readinessOf(outcome, timedOut);
  } finally {
    clearTimeout(timer);
    abort.removeEventListener('abort', stop);
  }
}

export interface ChooseAgentOptions {
  log: vscode.LogOutputChannel;
  /** Opens provider `id`'s own login in a terminal. */
  openLogin(id: ProviderId): void;
  /** Offered after a switch when the review panel shows an error (e.g. the old CLI wasn't found). */
  retry?: () => void;
}

/**
 * Shows the picker and, on a new choice, writes filos.provider to user settings and says what
 * happens next (log in, install, or nothing to do). Resolves with the chosen id, or undefined.
 */
export async function chooseAgent(opts: ChooseAgentOptions): Promise<ProviderId | undefined> {
  const current = readProviderId();
  const candidates: Candidate[] = PROVIDER_IDS.map((id) => {
    try {
      const cfg = readProviderConfig(id);
      const provider = createProvider(cfg);
      return { id, name: provider.displayName, executable: executableOf(cfg), provider, status: { kind: 'checking' } };
    } catch (e) {
      return { id, name: PROVIDER_NAMES[id], status: { kind: 'badSettings', reason: e instanceof Error ? e.message : String(e) } };
    }
  });

  const abort = new AbortController();
  const qp = vscode.window.createQuickPick<AgentItem>();
  qp.title = 'Filos: Choose the agent CLI';
  qp.placeholder = 'Filos runs it for every agent step, with your existing login. Saved in your user settings.';
  qp.matchOnDetail = false;
  let active: ProviderId = current;
  const items = (): AgentItem[] =>
    candidates.map((c) => ({
      id: c.id,
      label: c.name,
      description: [c.executable ? plain(c.executable) : undefined, c.id === current ? 'current' : undefined].filter(Boolean).join(' · '),
      detail: statusLine(c.status, pathSettingOf(c.id)),
    }));
  const render = () => {
    const list = items();
    qp.items = list;
    const keep = list.find((i) => i.id === active);
    if (keep) qp.activeItems = [keep];
    qp.busy = candidates.some((c) => c.status.kind === 'checking');
  };
  render();

  const checks = new Map<ProviderId, Promise<AgentStatus>>();
  for (const c of candidates) {
    if (!c.provider) continue;
    const started = Date.now();
    const p = check(c.provider, abort.signal).then((status) => {
      c.status = status;
      opts.log.info(`agent picker: ${c.id} ${status.kind}${status.kind === 'unknown' ? ` (${status.reason})` : ''} in ${Date.now() - started} ms`);
      if (!abort.signal.aborted) render();
      return status;
    });
    checks.set(c.id, p);
  }

  const picked = await new Promise<ProviderId | undefined>((resolve) => {
    let done = false;
    const finish = (id: ProviderId | undefined) => {
      if (done) return;
      done = true;
      resolve(id);
    };
    qp.onDidChangeActive((a) => {
      if (a[0]) active = a[0].id;
    });
    qp.onDidAccept(() => {
      finish(qp.selectedItems[0]?.id ?? qp.activeItems[0]?.id);
      qp.hide();
    });
    qp.onDidHide(() => {
      finish(undefined);
      qp.dispose();
    });
    qp.show();
  });

  const chosen = picked && candidates.find((c) => c.id === picked);
  if (!chosen) {
    abort.abort();
    return undefined;
  }
  // The chosen CLI's answer decides what to say next; wait for it (bounded by the timeout).
  const status = (await checks.get(chosen.id)) ?? chosen.status;
  abort.abort();
  if (chosen.id !== current) {
    await vscode.workspace.getConfiguration('filos').update('provider', chosen.id, vscode.ConfigurationTarget.Global);
    opts.log.info(`agent: filos.provider set to ${chosen.id} (${status.kind})`);
  }
  void tellNext(chosen, status, chosen.id !== current, opts);
  return chosen.id;
}

const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** After a choice: what still stands between the reviewer and a working agent, with the button that fixes it. */
async function tellNext(c: Candidate, status: AgentStatus, changed: boolean, opts: ChooseAgentOptions): Promise<void> {
  const now = changed ? `Filos: agent steps now run on ${c.name}.` : `Filos: agent steps already run on ${c.name}.`;
  const setting = pathSettingOf(c.id);
  if (status.kind === 'loggedOut') {
    const login = 'Log In';
    const choice = await vscode.window.showWarningMessage(`${now} You're not logged in to it yet.`, login);
    if (choice === login) opts.openLogin(c.id);
    return;
  }
  if (status.kind === 'notInstalled' || status.kind === 'badSettings') {
    const open = 'Open Settings';
    const found = status.kind === 'notInstalled' && c.executable ? foundOffPath(c.executable) : undefined;
    const why =
      status.kind === 'notInstalled'
        ? `Filos can't find its CLI ("${notice(c.executable ?? '', 120)}"). ${found ? `It is at ${notice(found, 160)}, which isn't on the PATH VS Code started with: set ${setting} to that path.` : `Install it, or set ${setting}.`}`
        : capital(notice(status.reason));
    const choice = await vscode.window.showWarningMessage(`${now} ${why}`, open);
    if (choice === open) await vscode.commands.executeCommand('workbench.action.openSettings', `filos.${c.id}.`);
    return;
  }
  if (!changed) return;
  const retry = 'Retry';
  const choice = await vscode.window.showInformationMessage(now, ...(opts.retry ? [retry] : []));
  if (choice === retry) opts.retry?.();
}

// Choosing a pull request: a quick pick of the workspace repository's open pull requests (listed by
// gh while the picker is already open), with "Enter a pull request URL or number…" first, and an
// input box for a URL, owner/repo#n or a number. Pasting a URL into the picker works too.
// PR titles and branch names come from GitHub: they are shown as text, and the picker's own
// "$(icon)" syntax is broken up so a title can't draw icons.

import * as vscode from 'vscode';
import { safeProgressText } from '../agent/progress';
import { cleanLine, describeInput, listPullRequests, parsePullRequestInput, type PullRequestInput, type PullRequestListItem } from './pr';

export interface PickOptions {
  gh: string;
  /** The workspace's repository (trusted workspaces only); without one, the input box opens directly. */
  repoRoot?: string;
  log: vscode.LogOutputChannel;
}

type Item = vscode.QuickPickItem & { input?: PullRequestInput; enter?: boolean };

const TITLE = 'Filos: Review Pull Request';

export function pickPullRequest(o: PickOptions): Promise<PullRequestInput | undefined> {
  if (!o.repoRoot) return askForPullRequest(false);
  const repoRoot = o.repoRoot;
  const qp = vscode.window.createQuickPick<Item>();
  qp.title = TITLE;
  qp.placeholder = 'Loading open pull requests…';
  qp.matchOnDescription = true;
  qp.matchOnDetail = true;
  qp.busy = true;
  qp.ignoreFocusOut = true;
  const enter: Item = { label: '$(edit) Enter a pull request URL or number…', enter: true, alwaysShow: true };
  let listed: Item[] = [];
  let typed: Item | undefined;
  // Setting items moves the highlight back to the first one: keep the reviewer's choice when the
  // list arrives or they type, unless a new "Review …" suggestion should take the highlight.
  const render = (keepActive = true) => {
    const active = qp.activeItems[0];
    qp.items = [...(typed ? [typed] : []), enter, ...listed];
    if (keepActive && active && qp.items.includes(active)) qp.activeItems = [active];
  };
  render();

  const cancel = new AbortController();
  void listPullRequests({ gh: o.gh, cwd: repoRoot, signal: cancel.signal })
    .then(
      (prs) => {
        listed = prs.length ? [{ label: 'Open pull requests', kind: vscode.QuickPickItemKind.Separator }, ...prs.map(toItem)] : [];
        qp.placeholder = prs.length ? 'Pick a pull request, or paste its URL' : 'No open pull requests in this repository: enter a URL or number';
      },
      (e: unknown) => {
        if (cancel.signal.aborted) return;
        const text = e instanceof Error ? e.message : String(e);
        o.log.warn(`listing pull requests in ${repoRoot}: ${text}`);
        qp.placeholder = `Couldn't list pull requests (${safeProgressText(text, 90)}). Enter a URL or number.`;
      },
    )
    .finally(() => {
      qp.busy = false;
      render();
    });

  qp.onDidChangeValue((v) => {
    const input = parsePullRequestInput(v);
    const label = input ? `$(arrow-right) Review ${describeInput(input)}` : undefined;
    if (label === typed?.label) return;
    typed = input && label ? { label, input, alwaysShow: true } : undefined;
    render(!typed);
  });

  return new Promise((resolve) => {
    let done = false;
    const finish = (v: PullRequestInput | undefined) => {
      if (done) return;
      done = true;
      cancel.abort();
      qp.dispose();
      resolve(v);
    };
    qp.onDidAccept(() => {
      const item = qp.selectedItems[0] ?? qp.activeItems[0];
      if (!item) return;
      if (item.enter) {
        done = true;
        cancel.abort();
        qp.dispose();
        void askForPullRequest(true).then(resolve, () => resolve(undefined));
        return;
      }
      if (item.input) finish(item.input);
    });
    qp.onDidHide(() => finish(undefined));
    qp.show();
  });
}

/**
 * An input box for a URL, owner/repo#n or (with a workspace repository) a number. It never reads the
 * clipboard: that is the user's, and in VS Code for the Web the read can stall on a permission prompt.
 */
export async function askForPullRequest(allowNumber: boolean): Promise<PullRequestInput | undefined> {
  const shapes = allowNumber ? 'https://<host>/<owner>/<repo>/pull/<n>, owner/repo#n or a number' : 'https://<host>/<owner>/<repo>/pull/<n> or owner/repo#n';
  const text = await vscode.window.showInputBox({
    title: TITLE,
    prompt: allowNumber ? "A pull request URL, owner/repo#number, or a number in this workspace's repository" : 'A pull request URL or owner/repo#number',
    placeHolder: 'https://github.com/owner/repo/pull/123',
    ignoreFocusOut: true,
    validateInput: (v) => {
      if (!v.trim()) return undefined;
      const input = parsePullRequestInput(v);
      if (!input) return `That isn't a pull request. Use ${shapes}.`;
      if (input.kind === 'number' && !allowNumber) return 'A bare number needs a workspace folder whose repository is on GitHub. Use the URL or owner/repo#n.';
      return undefined;
    },
  });
  if (!text?.trim()) return undefined;
  const input = parsePullRequestInput(text);
  return input && (input.kind !== 'number' || allowNumber) ? input : undefined;
}

function toItem(pr: PullRequestListItem): Item {
  const where = parsePullRequestInput(pr.url);
  const counts = pr.additions !== undefined && pr.deletions !== undefined ? `+${pr.additions} −${pr.deletions}` : '';
  const updated = pr.updatedAt ? `updated ${ago(Date.parse(pr.updatedAt))}` : '';
  return {
    label: `#${pr.number} ${noIcons(cleanLine(pr.title, 200))}`,
    iconPath: new vscode.ThemeIcon(pr.isDraft ? 'git-pull-request-draft' : 'git-pull-request'),
    description: [pr.isDraft ? 'Draft' : '', pr.author ? `by ${noIcons(pr.author)}` : ''].filter(Boolean).join(' · '),
    detail: [`${noIcons(pr.headRefName)} → ${noIcons(pr.baseRefName)}`, counts, updated].filter(Boolean).join(' · '),
    input: where ?? { kind: 'number', number: pr.number },
  };
}

/** "$(name)" draws an icon in a quick pick; a zero-width space after the "$" keeps it text. */
function noIcons(text: string): string {
  return text.replace(/\$\(/g, '$​(');
}

function ago(t: number, now = Date.now()): string {
  if (Number.isNaN(t)) return '';
  const s = Math.max(0, Math.round((now - t) / 1000));
  const units: [number, string][] = [
    [365 * 86400, 'year'],
    [30 * 86400, 'month'],
    [7 * 86400, 'week'],
    [86400, 'day'],
    [3600, 'hour'],
    [60, 'minute'],
  ];
  for (const [size, name] of units) {
    const n = Math.floor(s / size);
    if (n >= 1) return `${n} ${name}${n === 1 ? '' : 's'} ago`;
  }
  return 'just now';
}

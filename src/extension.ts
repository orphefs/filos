import * as vscode from 'vscode';
import { PR_SCHEME, registerPullRequestFiles } from './host/prFiles';
import { ReviewController, type BranchReviewOptions } from './host/review';
import { createTestApi, type FilosTestApi } from './host/testApi';

export interface FilosApi {
  /** Present only in development and test runs. */
  __test?: FilosTestApi;
}

export function activate(context: vscode.ExtensionContext): FilosApi {
  const log = vscode.window.createOutputChannel('Filos', { log: true });
  const controller = new ReviewController(context, log);

  // Commands never throw at the user: anything unexpected is logged and shown once.
  const command = <A extends unknown[]>(id: string, run: (...args: A) => Promise<void>) =>
    vscode.commands.registerCommand(id, async (...args: A) => {
      try {
        await run(...args);
      } catch (e) {
        log.error(`${id}: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`);
        void vscode.window.showErrorMessage(`Filos: ${e instanceof Error ? e.message : String(e)}`, 'Show Log').then((c) => c && log.show());
      }
    });

  context.subscriptions.push(
    log,
    controller,
    // Pull request code opens read-only as filos-pr: (never file:, so no other extension takes the
    // PR's checkout for a project of the user's and runs its code); it folds like any other file.
    registerPullRequestFiles(() => controller.pullRequestStorage),
    vscode.languages.registerFoldingRangeProvider([{ scheme: 'file' }, { scheme: PR_SCHEME }], controller.folding),
    // A GitHub pull request, by URL, owner/repo#n or number (an optional string argument), or picked.
    command('filos.reviewPullRequest', (arg?: unknown) => controller.reviewPullRequest(arg)),
    command('filos.cleanPullRequestCheckouts', () => controller.cleanPullRequestCheckouts()),
    command('filos.reviewSample', () => controller.reviewSample()),
    command('filos.reviewSampleWithAgent', () => controller.reviewSampleWithAgent()),
    command('filos.reviewCurrentBranch', (arg?: unknown) => controller.reviewCurrentBranch(branchOptions(arg))),
    // Base detection guesses (origin/HEAD, main, master); forks and PRs into develop need a choice.
    command('filos.reviewCurrentBranchAgainst', () => controller.reviewCurrentBranch({ pickBase: true })),
    // Deep link vscode://orphefs.filos/reviewSample opens the bundled sample. Links can come from any
    // web page, so only the free, local sample is reachable this way; never an agent run.
    vscode.window.registerUriHandler({
      handleUri: (uri) => {
        if (uri.path === '/reviewSample') void vscode.commands.executeCommand('filos.reviewSample');
        else log.warn(`ignored link ${uri.path}`);
      },
    }),
  );

  return context.extensionMode === vscode.ExtensionMode.Production ? {} : { __test: createTestApi(controller, context) };
}

/** Menus may pass a URI or other context as the first argument; only take what we understand. */
function branchOptions(arg: unknown): BranchReviewOptions {
  if (!arg || typeof arg !== 'object') return {};
  const a = arg as Record<string, unknown>;
  return { base: typeof a.base === 'string' ? a.base : undefined, pickBase: a.pickBase === true };
}

export function deactivate() {}

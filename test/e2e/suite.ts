// Entry point VS Code loads in the extension host (--extensionTestsPath). Bundled with the test
// files by esbuild.mjs, so each test file exports a function that declares its suites once the
// mocha globals exist, instead of declaring them at import time.

import Mocha from 'mocha';
import * as vscode from 'vscode';
import { registerAgentTests } from './agent.test';
import { registerBranchTests } from './branch.test';
import { registerClickTests } from './clicks.test';
import { cdpPort, filos, shot, workbench } from './helpers';
import { registerSampleTests } from './sample.test';

export async function run(): Promise<void> {
  const mocha = new Mocha({ ui: 'bdd', timeout: 60_000, color: true, reporter: 'spec' });
  const grep = process.env.FILOS_E2E_GREP;
  if (grep) mocha.grep(grep);
  // What `mocha` does per test file: install describe/it/before… on the global object.
  (mocha.suite as unknown as { emit(event: string, ...args: unknown[]): void }).emit('pre-require', globalThis, 'filos-e2e', mocha);

  before(async function () {
    await filos();
    // --disable-extensions raises a toast in the corner that would cover parts of the screen.
    await vscode.commands.executeCommand('notifications.clearAll');
    if (!cdpPort()) return;
    const wb = await workbench();
    // Without a window manager (Xvfb) VS Code ignores "maximized" and opens at its default size
    // for the screen: 1440x900 on runE2E's 1920x1080 display.
    console.log(`    window ${await wb.evalPage<string>('`${window.outerWidth}x${window.outerHeight}`')}`);
  });
  afterEach(async function () {
    if (this.currentTest?.state === 'failed') await shot(`FAILED ${this.currentTest.fullTitle()}`);
  });
  after(async function () {
    if (cdpPort()) (await workbench()).close();
  });

  // Order matters: the first suite checks the very first screen, before any view state exists.
  registerSampleTests();
  registerClickTests();
  registerAgentTests();
  registerBranchTests();

  const failures = await new Promise<number>((resolve) => mocha.run(resolve));
  if (failures > 0) throw new Error(`${failures} e2e test${failures === 1 ? '' : 's'} failed`);
}

// Bundles the extension host (node/cjs), the webview (browser/iife) and the e2e test runner.
import * as esbuild from 'esbuild';
import { cpSync, mkdirSync, existsSync } from 'node:fs';

const watch = process.argv.includes('--watch');
const common = { bundle: true, sourcemap: true, logLevel: 'info' };

const builds = [
  { ...common, entryPoints: ['src/extension.ts'], outfile: 'dist/extension.js', platform: 'node', format: 'cjs', target: 'node20', external: ['vscode'] },
  { ...common, entryPoints: ['src/webview/main.ts'], outfile: 'dist/webview.js', platform: 'browser', format: 'iife', target: 'chrome120', minify: true },
];
if (existsSync('test/e2e')) {
  builds.push({ ...common, entryPoints: ['test/e2e/runE2E.ts', 'test/e2e/suite.ts'], outdir: 'dist/test', platform: 'node', format: 'cjs', target: 'node20', external: ['vscode', 'mocha', '@vscode/test-electron'] });
}

mkdirSync('dist', { recursive: true });
if (existsSync('src/webview/styles.css')) cpSync('src/webview/styles.css', 'dist/webview.css');

if (watch) {
  for (const b of builds) (await esbuild.context(b)).watch();
} else {
  await Promise.all(builds.map((b) => esbuild.build(b)));
}

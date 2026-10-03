// Shared helpers for the e2e tests: the extension's test API, waiting, editors and folds, the
// sample graph (read from disk, independently of the extension), and the DevTools driver.

import * as assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, sep } from 'node:path';
import * as vscode from 'vscode';
import type { Anchor, GraphNode, Region, ReviewGraph } from '../../src/contract/graph';
import type { FilosApi } from '../../src/extension';
import type { FilosTestApi } from '../../src/host/testApi';
import type { RenderedInfo } from '../../src/host/session';
import { Workbench } from './cdp';

export const EXTENSION_ID = 'orphefs.filos';
export const SAMPLE_TITLE = "Switch to banker's rounding and add invoice discounts";

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

let apiPromise: Promise<FilosTestApi> | undefined;

/** The extension's test hooks (activates the extension on first use). */
export function filos(): Promise<FilosTestApi> {
  apiPromise ??= (async () => {
    const ext = vscode.extensions.getExtension<FilosApi>(EXTENSION_ID);
    assert.ok(ext, `extension ${EXTENSION_ID} is not installed in the test instance`);
    const api = await ext.activate();
    assert.ok(api.__test, 'the extension exposes no __test API (it only does in development and test runs)');
    return api.__test;
  })();
  return apiPromise;
}

export function extensionPath(): string {
  return vscode.extensions.getExtension(EXTENSION_ID)!.extensionPath;
}

/** Polls until `probe` returns something truthy; the error names what was awaited and the last value seen. */
export async function waitFor<T>(probe: () => T | undefined | null | false | Promise<T | undefined | null | false>, what: string, timeoutMs = 10_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: unknown;
  for (;;) {
    try {
      last = await probe();
      if (last) return last as T;
    } catch (e) {
      last = e instanceof Error ? e.message : e;
    }
    if (Date.now() > deadline) throw new Error(`timed out after ${timeoutMs} ms waiting for ${what} (last: ${brief(last)})`);
    await sleep(50);
  }
}

function brief(v: unknown): string {
  try {
    return JSON.stringify(v)?.slice(0, 400) ?? String(v);
  } catch {
    return String(v);
  }
}

/**
 * The next "rendered" report from the webview after `since` (a Date.now() taken before acting).
 * On timeout the error says what was awaited and what the webview last reported.
 */
export async function renderedAfter(since: number, predicate: (r: RenderedInfo) => boolean = () => true, timeoutMs = 10_000, what = predicate.toString()): Promise<RenderedInfo> {
  const api = await filos();
  try {
    return await api.waitForRendered((r) => r.at >= since && predicate(r), timeoutMs);
  } catch (e) {
    const last = api.getLastRendered();
    const lastText = last ? JSON.stringify({ ...last, at: `${last.at - since} ms after acting` }) : 'none';
    throw new Error(`webview did not report ${what} within ${timeoutMs} ms; last report: ${lastText}`);
  }
}

// ---- the sample graph, as the test reads it -------------------------------------------------

let graphCache: ReviewGraph | undefined;

export function sampleGraph(): ReviewGraph {
  graphCache ??= JSON.parse(readFileSync(join(extensionPath(), 'fixtures', 'sample-graph.json'), 'utf8')) as ReviewGraph;
  return graphCache;
}

export function node(id: string): GraphNode {
  const n = sampleGraph().nodes.find((x) => x.id === id);
  assert.ok(n, `the sample graph has no node "${id}"`);
  return n;
}

export const topLevel = () => sampleGraph().nodes.filter((n) => !n.parent);
export const modules = () => topLevel().filter((n) => n.kind === 'module').map((n) => n.id);
export const externals = () => topLevel().filter((n) => n.kind === 'external').map((n) => n.id);

/**
 * What the code pane should fold for these anchors, worked out here rather than taken from the
 * host: every multi-line region of the file that doesn't touch a relevant anchor.
 */
export function expectedFolds(file: string, relevant: Anchor[]): Region[] {
  const outline = sampleGraph().files.find((f) => f.path === file);
  if (!outline) return [];
  const mine = relevant.filter((a) => a.file === file);
  return outline.regions.filter((r) => r.endLine > r.startLine && !mine.some((a) => r.startLine <= a.endLine && a.startLine <= r.endLine));
}

// ---- editors ----------------------------------------------------------------------------------

/**
 * The visible text editor showing `relPath` (repo-relative, forward slashes), if any: a file: editor
 * (sample, branch), or a filos-pr: one (a pull request's code, read-only).
 */
export function editorFor(relPath: string): vscode.TextEditor | undefined {
  const tail = sep + relPath.split('/').join(sep);
  return vscode.window.visibleTextEditors.find((e) => (e.document.uri.scheme === 'file' || e.document.uri.scheme === 'filos-pr') && e.document.uri.fsPath.endsWith(tail));
}

export function isLineVisible(editor: vscode.TextEditor, line1: number): boolean {
  return editor.visibleRanges.some((r) => r.start.line <= line1 - 1 && line1 - 1 <= r.end.line);
}

export function rangesText(editor: vscode.TextEditor): string {
  return editor.visibleRanges.map((r) => `${r.start.line + 1}-${r.end.line + 1}`).join(',');
}

/** Lines of the document the viewport spans (folded or not). */
function viewportSpan(editor: vscode.TextEditor): { first: number; last: number } {
  const rs = editor.visibleRanges;
  return { first: rs[0].start.line + 1, last: rs[rs.length - 1].end.line + 1 };
}

/**
 * Asserts each region is folded on screen: its first line shows and the next one doesn't. Regions
 * whose first line is outside the viewport can't be judged and are skipped. Returns how many were
 * checked, so callers can insist that some were.
 */
export function assertFoldedOnScreen(editor: vscode.TextEditor, regions: Region[]): number {
  const { first, last } = viewportSpan(editor);
  let checked = 0;
  for (const r of regions) {
    if (r.startLine < first || r.startLine >= last) continue;
    checked++;
    assert.ok(isLineVisible(editor, r.startLine), `line ${r.startLine} (first line of folded ${r.symbol ?? 'region'}) should show; visible ${rangesText(editor)}`);
    for (let l = r.startLine + 1; l <= r.endLine; l++) {
      assert.ok(!isLineVisible(editor, l), `line ${l} is inside folded ${r.symbol ?? `region ${r.startLine}-${r.endLine}`} and should be hidden; visible ${rangesText(editor)}`);
    }
  }
  return checked;
}

/** Asserts every line of the anchors in this editor's file is on screen. */
export function assertAnchorsVisible(editor: vscode.TextEditor, file: string, anchors: Anchor[]): void {
  for (const a of anchors.filter((x) => x.file === file)) {
    for (let l = a.startLine; l <= a.endLine; l++) {
      assert.ok(isLineVisible(editor, l), `anchor line ${file}:${l} should be visible; visible ${rangesText(editor)}`);
    }
  }
}

// ---- DevTools (real input) --------------------------------------------------------------------

let workbenchPromise: Promise<Workbench> | undefined;

/** The DevTools driver, or undefined when VS Code wasn't started with a debugging port. */
export function cdpPort(): number | undefined {
  const p = Number(process.env.FILOS_E2E_CDP_PORT);
  return Number.isInteger(p) && p > 0 ? p : undefined;
}

export function workbench(): Promise<Workbench> {
  const port = cdpPort();
  if (!port) return Promise.reject(new Error('FILOS_E2E_CDP_PORT is not set: run the suite through runE2E'));
  workbenchPromise ??= Workbench.connect(port);
  return workbenchPromise;
}

let shotSeq = 0;

/** Saves a screenshot of the whole window (best effort) and returns its path. */
export async function shot(name: string): Promise<string | undefined> {
  const dir = process.env.FILOS_E2E_SHOTS;
  if (!dir || !cdpPort()) return undefined;
  try {
    const file = join(dir, `${String(++shotSeq).padStart(2, '0')}-${name.replace(/[^a-z0-9-]+/gi, '-')}.png`);
    await (await workbench()).screenshot(file);
    return file;
  } catch {
    return undefined;
  }
}

/** CSS selector for a graph node in the webview. */
export const nodeSel = (id: string) => `.layer-nodes [data-node-id=${JSON.stringify(id)}]`;

// Semantic folding: the graph's file outlines become folding ranges, and selecting a node folds
// every region that has nothing to do with it. Folded regions carry a gist (see codePane.ts).

import * as vscode from 'vscode';
import type { Anchor, FileOutline, Region } from '../contract/graph';

/** Outline lookup by document; undefined for files outside the current review. */
export type OutlineLookup = (uri: vscode.Uri) => FileOutline | undefined;

/**
 * One provider for all files. It answers only for files in the active review and returns
 * undefined (not []) elsewhere: an empty array would count as "this file has no folds" and switch
 * off VS Code's indentation fallback for every other file.
 */
export class OutlineFoldingProvider implements vscode.FoldingRangeProvider, vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChangeFoldingRanges = this.changed.event;

  constructor(private readonly lookup: OutlineLookup) {}

  provideFoldingRanges(document: vscode.TextDocument): vscode.FoldingRange[] | undefined {
    const outline = this.lookup(document.uri);
    if (!outline) return undefined;
    return foldableRegions(outline)
      .filter((r) => r.endLine <= document.lineCount)
      .map((r) => new vscode.FoldingRange(r.startLine - 1, r.endLine - 1));
  }

  /** Call when the review (and so the set of outlines) changes. */
  refresh(): void {
    this.changed.fire();
  }

  dispose(): void {
    this.changed.dispose();
  }
}

/** A one-line region can't fold, so it never gets a fold or a gist. */
export function foldableRegions(outline: FileOutline): Region[] {
  return outline.regions.filter((r) => r.endLine > r.startLine);
}

export interface FoldPlan {
  /** Regions to collapse: they don't touch any relevant anchor. Outermost first. */
  fold: Region[];
  /** Regions to expand: they contain or overlap a relevant anchor. */
  unfold: Region[];
}

const intersects = (r: Region, a: Anchor) => r.startLine <= a.endLine && a.startLine <= r.endLine;

/** Pure: which regions of a file to fold and unfold so only the code relevant to `anchors` is open. */
export function planFolds(outline: FileOutline, anchors: readonly Anchor[]): FoldPlan {
  const relevant = anchors.filter((a) => a.file === outline.path);
  const fold: Region[] = [];
  const unfold: Region[] = [];
  for (const r of foldableRegions(outline)) (relevant.some((a) => intersects(r, a)) ? unfold : fold).push(r);
  const outerFirst = (a: Region, b: Region) => a.startLine - b.startLine || b.endLine - a.endLine;
  return { fold: fold.sort(outerFirst), unfold: unfold.sort(outerFirst) };
}

/** 1-based line visible in the editor right now? */
export function isLineVisible(editor: vscode.TextEditor, line1: number): boolean {
  return editor.visibleRanges.some((r) => r.start.line <= line1 - 1 && line1 - 1 <= r.end.line);
}

/**
 * Whether a region is folded, judged from the editor's visible ranges. Undefined when the
 * viewport doesn't show enough to tell (start line off screen, or its next line is past the end).
 */
export function observedFolded(editor: vscode.TextEditor, r: Region): boolean | undefined {
  const ranges = editor.visibleRanges;
  if (!ranges.length || !isLineVisible(editor, r.startLine)) return undefined;
  const lastVisible = ranges[ranges.length - 1].end.line + 1;
  if (r.startLine >= lastVisible) return undefined;
  return !isLineVisible(editor, r.startLine + 1);
}

/** True when nothing on screen contradicts the plan: planned folds are folded, relevant regions are open. */
export function planHolds(editor: vscode.TextEditor, plan: FoldPlan): boolean {
  return plan.fold.every((r) => observedFolded(editor, r) !== false) && plan.unfold.every((r) => observedFolded(editor, r) !== true);
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Applies a fold plan to `editor`, which must be focused: VS Code's fold commands act on the
 * focused editor only, and silently do nothing otherwise. Folding ranges are computed
 * asynchronously after a file opens (and after our provider fires), so the first attempt can hit
 * a model without our regions; retry until the visible ranges agree with the plan or the deadline
 * passes. Before each retry `focus` is called again: focus can be taken away meanwhile (by a
 * previous selection handing focus back to the graph, say).
 */
export interface FoldOutcome {
  /** The visible ranges agree with the plan. */
  verified: boolean;
  attempts: number;
  ms: number;
}

export async function applyFoldPlan(
  editor: vscode.TextEditor,
  plan: FoldPlan,
  opts: { isCurrent: () => boolean; focus: () => Thenable<unknown>; timeoutMs?: number },
): Promise<FoldOutcome> {
  const started = Date.now();
  const done = (verified: boolean, attempts: number): FoldOutcome => ({ verified, attempts, ms: Date.now() - started });
  if (!plan.fold.length && !plan.unfold.length) return done(true, 0);
  const deadline = started + (opts.timeoutMs ?? 3000);
  const lines = (rs: Region[]) => rs.map((r) => r.startLine - 1);
  for (let attempt = 1; ; attempt++) {
    if (attempt > 1) await opts.focus();
    if (!opts.isCurrent() || vscode.window.activeTextEditor?.document !== editor.document) return done(false, attempt - 1);
    if (plan.unfold.length) await vscode.commands.executeCommand('editor.unfold', { selectionLines: lines(plan.unfold), levels: 1 });
    if (plan.fold.length) await vscode.commands.executeCommand('editor.fold', { selectionLines: lines(plan.fold), levels: 1 });
    // visibleRanges reach the extension host as a separate event after the command returns, and
    // can lag a few hundred ms on a busy renderer. Waiting is cheaper than re-issuing the commands.
    for (let i = 0; i < 20; i++) {
      await sleep(25);
      // With every planned fold off screen we can't see whether the model was ready, so give it a second pass.
      const seen = plan.fold.length === 0 || plan.fold.some((r) => observedFolded(editor, r) !== undefined);
      if (planHolds(editor, plan) && (seen || attempt >= 2)) return done(true, attempt);
    }
    if (Date.now() > deadline) return done(false, attempt);
    await sleep(Math.min(400, 50 * 2 ** (attempt - 1)));
  }
}

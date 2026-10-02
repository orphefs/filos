// The code pane is the native editor beside the graph. Selecting a node opens its code there,
// folds everything unrelated down to one-line gists and tints the relevant lines by risk.
//
// Gists follow the folds, not the selection: any outline region that is folded (by us, by hand,
// or restored by VS Code after a reload) shows its gist, so a fold is never blank.

import { existsSync } from 'node:fs';
import * as vscode from 'vscode';
import type { Anchor, Region } from '../contract/graph';
import { applyFoldPlan, foldableRegions, observedFolded, planFolds, type FoldPlan } from './folding';
import type { ReviewSession } from './session';

/** Risk tint steps. Decoration types have fixed colours, so the level is bucketed. */
const BUCKETS = 5;
const DARK_ALPHA = [0.08, 0.12, 0.17, 0.23, 0.3];
const LIGHT_ALPHA = [0.06, 0.09, 0.13, 0.18, 0.24];

export interface CodePaneSnapshot {
  nodeId?: string;
  /** Repo-relative path of the file shown. */
  file?: string;
  uri?: string;
  relevant: Anchor[];
  /** Regions the last selection folded / unfolded (1-based lines). */
  folded: Region[];
  unfolded: Region[];
  /** Whether the editor's visible ranges confirmed the folds, and what it took. */
  foldVerified: boolean;
  foldAttempts: number;
  foldMs: number;
  /** Start lines (1-based) of the shown file currently decorated with a gist, and the gist text. */
  gists: { line: number; gist: string }[];
  highlights: { startLine: number; endLine: number; bucket: number }[];
}

/** What the last selection put in the code pane. */
interface Selection {
  /** Undefined after selecting a node without code (an external): the file stays as it was. */
  nodeId?: string;
  uri: vscode.Uri;
  file: string;
  relevant: Anchor[];
  plan: FoldPlan;
  bucket: number;
  verified: boolean;
  attempts: number;
  ms: number;
}

export interface CodePaneHost {
  /** The review panel, used to place the code beside it and to give focus back to the graph. */
  panel(): vscode.WebviewPanel | undefined;
  log: vscode.LogOutputChannel;
}

export class CodePane implements vscode.Disposable {
  private generation = 0;
  private queue: Promise<void> = Promise.resolve();
  private session?: ReviewSession;
  private selection?: Selection;
  /** Last known fold state per file (uri) and region start line: from our plans, then from the screen. */
  private foldState = new Map<string, Map<number, boolean>>();
  /**
   * The file we are folding right now. Its screen is mid-change (opening, scrolling, folding), so
   * observations would overwrite the plan with the state from before the folds.
   */
  private applying?: string;
  private readonly riskTypes: vscode.TextEditorDecorationType[];
  private readonly gistType: vscode.TextEditorDecorationType;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(private readonly host: CodePaneHost) {
    this.riskTypes = Array.from({ length: BUCKETS }, (_, b) =>
      vscode.window.createTextEditorDecorationType({
        isWholeLine: true,
        dark: { backgroundColor: `rgba(255, 92, 92, ${DARK_ALPHA[b]})` },
        light: { backgroundColor: `rgba(214, 40, 40, ${LIGHT_ALPHA[b]})` },
        overviewRulerColor: `rgba(230, 60, 60, ${0.45 + 0.12 * b})`,
        overviewRulerLane: vscode.OverviewRulerLane.Left,
      }),
    );
    this.gistType = vscode.window.createTextEditorDecorationType({
      after: { color: new vscode.ThemeColor('editorCodeLens.foreground'), fontStyle: 'italic', margin: '0 0 0 1.5em' },
    });
    this.disposables.push(
      ...this.riskTypes,
      this.gistType,
      // Decorations belong to an editor instance and vanish when its tab is hidden; put them back.
      vscode.window.onDidChangeVisibleTextEditors((editors) => {
        for (const e of editors) if (this.inReview(e)) this.decorate(e);
      }),
      // Folds toggled by hand get (or lose) their gist too.
      vscode.window.onDidChangeTextEditorVisibleRanges((ev) => {
        if (this.inReview(ev.textEditor)) this.updateGists(ev.textEditor);
      }),
    );
  }

  /**
   * A new review (or none). A re-run of the same PR keeps the folds' gists and drops only the
   * highlight. A different review (or closing the panel) also closes the preview tab Filos opened
   * for the old one: its code next to another PR's graph would mislead, and its folds would lose
   * their gists. Tabs the user pinned or edited stay.
   */
  setSession(session: ReviewSession | undefined): void {
    const previous = this.session;
    const sameReview = !!previous && !!session && previous.key === session.key;
    this.generation++;
    this.session = session;
    this.selection = undefined;
    if (sameReview) {
      for (const e of vscode.window.visibleTextEditors) for (const t of this.riskTypes) e.setDecorations(t, []);
      return;
    }
    this.clearDecorations();
    this.foldState.clear();
    if (previous) void this.closePreviews(previous);
  }

  private async closePreviews(previous: ReviewSession): Promise<void> {
    const stale = vscode.window.tabGroups.all
      .flatMap((g) => g.tabs)
      .filter((t) => t.isPreview && !t.isDirty && t.input instanceof vscode.TabInputText && !!previous.outlineFor(t.input.uri) && !this.session?.outlineFor(t.input.uri));
    if (stale.length) await vscode.window.tabGroups.close(stale, true);
  }

  /** The review's outlines changed (a graph loaded): decorate files that are already open. */
  refresh(): void {
    for (const e of vscode.window.visibleTextEditors) if (this.inReview(e)) this.decorate(e);
  }

  /** Opens the code for a node (or one specific anchor of it). Later calls supersede earlier ones. */
  show(nodeId: string, anchorIndex?: number): Promise<void> {
    const gen = ++this.generation;
    const session = this.session;
    if (!session) return Promise.resolve();
    this.queue = this.queue
      .then(() => this.run(session, nodeId, anchorIndex, gen))
      .catch((e: unknown) => this.host.log.error(`code pane: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`));
    return this.queue;
  }

  snapshot(): CodePaneSnapshot {
    const s = this.selection;
    if (!s) return { relevant: [], folded: [], unfolded: [], foldVerified: false, foldAttempts: 0, foldMs: 0, gists: [], highlights: [] };
    return {
      nodeId: s.nodeId,
      file: s.file,
      uri: s.uri.toString(),
      relevant: s.relevant,
      folded: s.plan.fold,
      unfolded: s.plan.unfold,
      foldVerified: s.verified,
      foldAttempts: s.attempts,
      foldMs: s.ms,
      gists: this.gistRegions(s.uri).map((r) => ({ line: r.startLine, gist: r.gist })),
      highlights: s.relevant.map((a) => ({ startLine: a.startLine, endLine: a.endLine, bucket: s.bucket })),
    };
  }

  private async run(session: ReviewSession, nodeId: string, anchorIndex: number | undefined, gen: number): Promise<void> {
    const isCurrent = () => gen === this.generation;
    if (!isCurrent()) return;
    const node = session.node(nodeId);
    if (!node) {
      this.host.log.warn(`select: unknown node "${nodeId}"`);
      return;
    }
    const anchors = session.anchorsFor(node);
    if (!anchors.length) {
      // Externals (and anchorless nodes) have no code here; the summary pane explains them.
      // Drop the highlight and leave the file (and its gists) as it is.
      if (this.selection) Object.assign(this.selection, { nodeId: undefined, relevant: [] });
      this.refresh();
      return;
    }
    const primary = anchors[Math.max(0, Math.min(anchorIndex ?? 0, anchors.length - 1))];
    const relevant = anchors.filter((a) => a.file === primary.file);
    const uri = session.uriFor(primary.file);
    if (!existsSync(uri.fsPath)) {
      this.host.log.warn(`select ${nodeId}: ${primary.file} does not exist in ${session.target.repoRoot}`);
      void vscode.window.showWarningMessage(`Filos: ${primary.file} isn't in the checked-out head revision.`);
      return;
    }

    const doc = await vscode.workspace.openTextDocument(uri);
    if (!isCurrent()) return;
    const outline = session.outlineFor(uri);
    const plan = outline ? planFolds(outline, relevant) : { fold: [], unfold: [] };
    const level = session.scores.get(node.id)?.level ?? 0;
    const selection: Selection = { nodeId, uri, file: primary.file, relevant, plan, bucket: Math.min(BUCKETS - 1, Math.floor(level * BUCKETS)), verified: false, attempts: 0, ms: 0 };

    let editor: vscode.TextEditor | undefined;
    this.applying = uri.toString();
    try {
      editor = await this.openAndFold(doc, selection, primary, isCurrent);
    } finally {
      if (this.applying === uri.toString()) this.applying = undefined;
    }
    if (!editor || !isCurrent()) return;
    // Folding shrinks the file but keeps the old scroll position. Start from the top so a file that
    // now fits is seen whole, then bring the anchor into view if it is further down.
    editor.revealRange(new vscode.Range(0, 0, 0, 0), vscode.TextEditorRevealType.AtTop);
    editor.revealRange(anchorRange(primary), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
    this.updateGists(editor);
    await this.returnFocus();
  }

  /** Shows the file beside the graph, highlights the selection and applies its fold plan. */
  private async openAndFold(doc: vscode.TextDocument, selection: Selection, primary: Anchor, isCurrent: () => boolean): Promise<vscode.TextEditor | undefined> {
    // The fold commands act on the focused editor, so this editor has to take focus for a moment.
    // The cursor goes on the anchor first: folding re-opens any region that would hide the cursor.
    const cursor = new vscode.Position(primary.startLine - 1, 0);
    const editor = await vscode.window.showTextDocument(doc, { viewColumn: this.codeColumn(), preserveFocus: false, preview: true, selection: new vscode.Range(cursor, cursor) });
    if (!isCurrent()) return undefined;

    this.selection = selection;
    const state = this.stateFor(doc.uri);
    for (const r of selection.plan.fold) state.set(r.startLine, true);
    for (const r of selection.plan.unfold) state.set(r.startLine, false);
    // Only one file carries the highlight: clear it from wherever the previous selection put it.
    for (const e of vscode.window.visibleTextEditors) if (e !== editor) for (const t of this.riskTypes) e.setDecorations(t, []);
    this.decorate(editor);
    editor.revealRange(anchorRange(primary), vscode.TextEditorRevealType.InCenterIfOutsideViewport);

    const focus = () => vscode.window.showTextDocument(doc, { viewColumn: editor.viewColumn, preserveFocus: false, preview: true });
    const outcome = await applyFoldPlan(editor, selection.plan, { isCurrent, focus });
    if (!isCurrent()) return undefined;
    Object.assign(selection, { verified: outcome.verified, attempts: outcome.attempts, ms: outcome.ms });
    const how = `${selection.plan.fold.length} folded, ${outcome.attempts} attempt(s), ${outcome.ms} ms`;
    if (outcome.verified) this.host.log.debug(`select ${selection.nodeId}: ${selection.file}, ${how}`);
    else this.host.log.warn(`select ${selection.nodeId}: folds in ${selection.file} not confirmed on screen (${how})`);
    return editor;
  }

  /** Beside the graph: the column right of the panel (Two when the panel is in One). */
  private codeColumn(): vscode.ViewColumn {
    const col = this.host.panel()?.viewColumn ?? vscode.ViewColumn.One;
    return Math.min(col + 1, vscode.ViewColumn.Nine) as vscode.ViewColumn;
  }

  /**
   * Back to the graph, so keyboard navigation there keeps working. Waits (briefly) until the panel
   * is active: reveal() returns before focus moves, and a late focus change would otherwise land
   * in the middle of the next selection and leave its fold commands without a focused editor.
   */
  private async returnFocus(): Promise<void> {
    const panel = this.host.panel();
    if (!panel) return;
    panel.reveal(panel.viewColumn, false);
    if (panel.active) return;
    await new Promise<void>((resolve) => {
      const done = () => {
        sub.dispose();
        clearTimeout(timer);
        resolve();
      };
      const sub = panel.onDidChangeViewState((e) => e.webviewPanel.active && done());
      const timer = setTimeout(done, 500);
    });
  }

  private inReview(editor: vscode.TextEditor): boolean {
    return !!this.session?.outlineFor(editor.document.uri);
  }

  private stateFor(uri: vscode.Uri): Map<number, boolean> {
    const key = uri.toString();
    let state = this.foldState.get(key);
    if (!state) this.foldState.set(key, (state = new Map()));
    return state;
  }

  private decorate(editor: vscode.TextEditor): void {
    const s = this.selection;
    const mine = s && s.uri.toString() === editor.document.uri.toString() ? s : undefined;
    const ranges = mine ? mine.relevant.map(anchorRange) : [];
    this.riskTypes.forEach((t, b) => editor.setDecorations(t, mine && b === mine.bucket ? ranges : []));
    this.updateGists(editor);
  }

  /** Gists go on the start line of every outline region that is folded right now. */
  private updateGists(editor: vscode.TextEditor): void {
    const outline = this.session?.outlineFor(editor.document.uri);
    if (!outline) return;
    const state = this.stateFor(editor.document.uri);
    if (this.applying !== editor.document.uri.toString()) {
      for (const r of foldableRegions(outline)) {
        const seen = observedFolded(editor, r);
        if (seen !== undefined) state.set(r.startLine, seen);
      }
    }
    const doc = editor.document;
    const decorations = this.gistRegions(editor.document.uri)
      .filter((r) => r.startLine <= doc.lineCount)
      .map((r): vscode.DecorationOptions => {
        const line = doc.lineAt(r.startLine - 1);
        const hover = new vscode.MarkdownString();
        hover.appendMarkdown(`**Filos** · ${r.symbol ? `\`${r.symbol}\` — ` : ''}`).appendText(r.gist);
        return {
          range: new vscode.Range(line.lineNumber, line.firstNonWhitespaceCharacterIndex, line.lineNumber, line.text.length),
          hoverMessage: hover,
          renderOptions: { after: { contentText: `— ${truncate(r.gist, 140)}` } },
        };
      });
    editor.setDecorations(this.gistType, decorations);
  }

  private gistRegions(uri: vscode.Uri): Region[] {
    const outline = this.session?.outlineFor(uri);
    const state = this.foldState.get(uri.toString());
    return outline && state ? foldableRegions(outline).filter((r) => state.get(r.startLine) === true) : [];
  }

  private clearDecorations(): void {
    for (const e of vscode.window.visibleTextEditors) {
      for (const t of this.riskTypes) e.setDecorations(t, []);
      e.setDecorations(this.gistType, []);
    }
  }

  dispose(): void {
    this.generation++;
    for (const d of this.disposables) d.dispose();
  }
}

const truncate = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + '…' : s);
const anchorRange = (a: Anchor) => new vscode.Range(a.startLine - 1, 0, a.endLine - 1, 0);

// The code pane is the native editor beside the graph. Selecting a node opens its code there,
// folds everything unrelated down to one-line gists and tints the relevant lines by risk.
//
// Gists follow the folds, not the selection: any outline region that is folded (by us, by hand,
// or restored by VS Code after a reload) shows its gist, so a fold is never blank.

import { existsSync } from 'node:fs';
import * as vscode from 'vscode';
import { safeProgressText } from '../agent/progress';
import type { Anchor, Region } from '../contract/graph';
import { applyFoldPlan, foldableRegions, observedFolded, planFolds, type FoldPlan } from './folding';
import { codeSpan, literal } from './markdown';
import type { ReviewSession } from './session';
import { revertEdit, undoBackTo } from './strayEdits';

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
    if (!uri || !existsSync(session.absPath(primary.file))) {
      this.host.log.warn(`select ${nodeId}: ${primary.file} does not exist in ${session.target.repoRoot}`);
      // The path comes from the agent, and notifications turn [label](command:…) into a link that
      // runs a command: show it without link syntax.
      void vscode.window.showWarningMessage(`Filos: ${safeProgressText(primary.file)} isn't in the checked-out head revision.`);
      return;
    }

    const doc = await vscode.workspace.openTextDocument(uri);
    if (!isCurrent()) return;
    const outline = session.outlineFor(uri);
    const plan = outline ? planFolds(outline, relevant) : { fold: [], unfold: [] };
    const level = session.scores.get(node.id)?.level ?? 0;
    const selection: Selection = { nodeId, uri, file: primary.file, relevant, plan, bucket: Math.min(BUCKETS - 1, Math.floor(level * BUCKETS)), verified: false, attempts: 0, ms: 0 };

    // From here until focus is back on the graph, keys meant for the graph can land in the file.
    const stray = new StrayEdits(doc);
    try {
      let editor: vscode.TextEditor | undefined;
      this.applying = uri.toString();
      try {
        editor = await this.openAndFold(doc, selection, primary, isCurrent);
      } finally {
        if (this.applying === uri.toString()) this.applying = undefined;
      }
      if (editor && isCurrent()) {
        // Folding shrinks the file but keeps the old scroll position. Start from the top so a file that
        // now fits is seen whole, then bring the anchor into view if it is further down.
        editor.revealRange(new vscode.Range(0, 0, 0, 0), vscode.TextEditorRevealType.AtTop);
        editor.revealRange(anchorRange(primary), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
        this.updateGists(editor);
      }
      // Undo needs our editor active, so it goes before handing focus back; keys that land while
      // focus travels back are reverted after.
      await stray.undo();
      // Only while Filos still holds focus here: if the user went to another editor, leave them there.
      if (editor && isCurrent() && vscode.window.activeTextEditor?.document === doc) await this.returnFocus();
      await stray.revert();
      const report = stray.report(selection.file);
      if (report) this.host.log.warn(`select ${nodeId}: ${report}`);
    } finally {
      stray.dispose();
    }
  }

  /** Shows the file beside the graph, highlights the selection and applies its fold plan. */
  private async openAndFold(doc: vscode.TextDocument, selection: Selection, primary: Anchor, isCurrent: () => boolean): Promise<vscode.TextEditor | undefined> {
    // The fold commands act on the active editor, and making this one active means focusing it for a
    // moment. The cursor goes on the anchor first: folding re-opens any region that would hide it.
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

    // Focus that went back to the graph mid-fold (a previous selection handing it back late, or the
    // graph focusing a node after it redraws) is taken back; anywhere else the user has moved on.
    // Keys typed into the editor meanwhile are taken back (see StrayEdits).
    const refocus = async () => {
      if (!this.host.panel()?.active) return false;
      await vscode.window.showTextDocument(doc, { viewColumn: editor.viewColumn, preserveFocus: false, preview: true });
      return true;
    };
    const outcome = await applyFoldPlan(editor, selection.plan, { isCurrent, refocus });
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
        // Symbol and gist come from the agent, which the PR can steer: both render literally, so
        // neither can add images, HTML or links to the hover.
        const hover = new vscode.MarkdownString();
        hover.isTrusted = false;
        hover.supportHtml = false;
        hover.supportThemeIcons = false;
        const symbol = r.symbol ? codeSpan(truncate(r.symbol, 120)) : '';
        hover.appendMarkdown(`**Filos** · ${symbol ? `${symbol} — ` : ''}${literal(r.gist)}`);
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

/**
 * Keys the user meant for the graph that landed in the file while Filos held focus in its editor
 * to fold it. Filos never edits the file, so any edit in that window is one of those, unless the
 * file was reloaded from disk (it is then clean and unsaved, and not ours to touch).
 */
class StrayEdits implements vscode.Disposable {
  private readonly before: string;
  /** Edits seen, not counting undo and redo (ours, or a stray Ctrl+Z) or our own revert. */
  private seen = 0;
  private saved = false;
  private reverting = false;
  private outcome?: string;
  private readonly subs: vscode.Disposable[];

  constructor(private readonly doc: vscode.TextDocument) {
    this.before = doc.getText();
    this.subs = [
      vscode.workspace.onDidChangeTextDocument((e) => {
        const undoRedo = e.reason === vscode.TextDocumentChangeReason.Undo || e.reason === vscode.TextDocumentChangeReason.Redo;
        if (e.document === doc && e.contentChanges.length && !undoRedo && !this.reverting) this.seen++;
      }),
      vscode.workspace.onDidSaveTextDocument((d) => {
        if (d === doc) this.saved = true;
      }),
    ];
  }

  /** The file differs from the snapshot because keys were typed into it. */
  private get stray(): boolean {
    return this.seen > 0 && (this.doc.isDirty || this.saved) && this.doc.getText() !== this.before;
  }

  /**
   * First choice, while our editor is still active: the editor's own undo, which also clears the
   * dirty flag. Undo acts on the focused (else the active) editor, so every step checks that ours
   * is still the active one.
   */
  async undo(): Promise<void> {
    if (!this.stray) return;
    const step = (command: 'undo' | 'redo') => async () => {
      if (vscode.window.activeTextEditor?.document !== this.doc) return false;
      await vscode.commands.executeCommand(command);
      return true;
    };
    if (await undoBackTo({ text: () => this.doc.getText(), undo: step('undo'), redo: step('redo') }, this.before, () => this.seen)) this.outcome = 'undone';
  }

  /**
   * Needs no focus, for keys that land while focus travels back to the graph, or that undo could
   * not take back: one edit puts the snapshot back. The file then stays marked unsaved.
   */
  async revert(): Promise<void> {
    for (let i = 0; i < 3 && this.stray; i++) {
      const r = revertEdit(this.doc.getText(), this.before);
      const edit = new vscode.WorkspaceEdit();
      edit.replace(this.doc.uri, new vscode.Range(this.doc.positionAt(r.start), this.doc.positionAt(r.end)), r.text);
      this.reverting = true;
      try {
        if (await vscode.workspace.applyEdit(edit)) this.outcome = 'reverted (the file stays marked unsaved)';
      } finally {
        this.reverting = false;
      }
    }
    if (this.stray) this.outcome = 'left in place: revert failed';
  }

  /** For the log: what was typed into the file and what became of it. */
  report(file: string): string | undefined {
    return this.outcome && `${this.seen} edit(s) typed into ${file} while Filos held focus to fold it: ${this.outcome}`;
  }

  dispose(): void {
    for (const s of this.subs) s.dispose();
  }
}

const truncate = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + '…' : s);
const anchorRange = (a: Anchor) => new vscode.Range(a.startLine - 1, 0, a.endLine - 1, 0);

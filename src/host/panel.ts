// The review webview: a bare HTML shell (the webview script builds the whole UI), a strict CSP,
// and typed messages. Messages posted before the script says "ready" would be dropped, so the host
// answers "ready" with a full snapshot instead of relying on earlier posts.

import { randomBytes } from 'node:crypto';
import * as vscode from 'vscode';
import { DEPTHS, type Depth } from '../contract/questions';
import type { HostToWebview, ReviewAction, WebviewToHost } from '../protocol';

export const PANEL_VIEW_TYPE = 'filos.review';

export interface PanelHandlers {
  onMessage(msg: WebviewToHost): void;
  onDispose(): void;
}

export class ReviewPanel implements vscode.Disposable {
  private panel?: vscode.WebviewPanel;
  private ready = false;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly handlers: PanelHandlers,
    private readonly log: vscode.LogOutputChannel,
  ) {}

  get webviewPanel(): vscode.WebviewPanel | undefined {
    return this.panel;
  }

  /** Shows the panel, creating it if needed, and focuses it: the user just asked for a review. */
  open(prTitle: string): void {
    const title = `Filos: ${prTitle}`;
    if (this.panel) {
      this.panel.title = title;
      this.panel.reveal(this.panel.viewColumn ?? vscode.ViewColumn.One, false);
      return;
    }
    const dist = vscode.Uri.joinPath(this.extensionUri, 'dist');
    const panel = vscode.window.createWebviewPanel(PANEL_VIEW_TYPE, title, vscode.ViewColumn.One, {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [dist],
    });
    this.panel = panel;
    this.ready = false;
    panel.webview.html = shellHtml(panel.webview, dist);
    this.disposables.push(
      panel.webview.onDidReceiveMessage((raw: unknown) => {
        const msg = parseWebviewMessage(raw);
        if (!msg) {
          this.log.warn(`webview sent an unrecognised message: ${safeJson(raw)}`);
          return;
        }
        if (msg.type === 'ready') this.ready = true;
        this.handlers.onMessage(msg);
      }),
      panel.onDidDispose(() => {
        this.panel = undefined;
        this.ready = false;
        for (const d of this.disposables.splice(0)) d.dispose();
        this.handlers.onDispose();
      }),
    );
  }

  /** Sends a message if the webview is listening; otherwise the next "ready" snapshot covers it. */
  post(msg: HostToWebview): void {
    if (!this.panel || !this.ready) return;
    void this.panel.webview.postMessage(msg).then(
      (ok) => ok || this.log.debug(`webview did not accept ${msg.type}`),
      (e: unknown) => this.log.warn(`postMessage ${msg.type} failed: ${String(e)}`),
    );
  }

  get isReady(): boolean {
    return this.ready;
  }

  dispose(): void {
    this.panel?.dispose();
  }
}

function shellHtml(webview: vscode.Webview, dist: vscode.Uri): string {
  const nonce = randomBytes(16).toString('base64');
  const script = webview.asWebviewUri(vscode.Uri.joinPath(dist, 'webview.js'));
  const style = webview.asWebviewUri(vscode.Uri.joinPath(dist, 'webview.css'));
  const csp = [
    "default-src 'none'",
    `script-src 'nonce-${nonce}'`,
    `style-src ${webview.cspSource} 'unsafe-inline'`,
    `img-src ${webview.cspSource} data:`,
    `font-src ${webview.cspSource}`,
  ].join('; ');
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${style}">
<title>Filos</title>
</head>
<body>
<div id="app"></div>
<script nonce="${nonce}" src="${script}"></script>
</body>
</html>`;
}

const VIEW_TYPES = new Set<string>(['ready', 'select', 'openAnchor', 'stateChanged', 'action', 'rendered']);

/** Every ReviewAction type; the host applies these to the review model. */
export const REVIEW_ACTION_TYPES: ReadonlySet<string> = new Set<ReviewAction['type']>([
  'setMode',
  'setDepth',
  'enter',
  'familiarity',
  'cancelGate',
  'answer',
  'selfCheck',
  'commentAction',
  'amend',
  'thread',
  'adoptProposal',
  'addNote',
  'draftWithAgent',
  'post',
  'exportReview',
]);

/** Free text from the webview (answers, notes, amended bodies) is bounded: the webview is ours, but the text may be pasted. */
export const MAX_ACTION_TEXT = 50_000;

/**
 * Shape check at the trust boundary: the webview is ours, but its messages are still just data.
 * Review actions come back as fresh objects with only their known fields.
 */
export function parseWebviewMessage(raw: unknown): WebviewToHost | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const m = raw as Record<string, unknown>;
  if (typeof m.type !== 'string') return undefined;
  if (REVIEW_ACTION_TYPES.has(m.type)) return parseReviewAction(m);
  if (!VIEW_TYPES.has(m.type)) return undefined;
  const strs = (v: unknown) => Array.isArray(v) && v.every((x) => typeof x === 'string');
  switch (m.type) {
    case 'select':
      return typeof m.id === 'string' ? (m as unknown as WebviewToHost) : undefined;
    case 'openAnchor':
      return typeof m.id === 'string' && Number.isInteger(m.anchorIndex) ? (m as unknown as WebviewToHost) : undefined;
    case 'stateChanged': {
      const s = m.state as Record<string, unknown> | undefined;
      return s && strs(s.expanded) && strs(s.visited) && (s.selected === undefined || typeof s.selected === 'string') ? (m as unknown as WebviewToHost) : undefined;
    }
    case 'action':
      return ['login', 'retry', 'useFixture', 'chooseAgent', 'rerun'].includes(m.action as string) ? (m as unknown as WebviewToHost) : undefined;
    case 'rendered':
      return strs(m.visibleNodes) && strs(m.expanded) ? (m as unknown as WebviewToHost) : undefined;
    default:
      return m as unknown as WebviewToHost;
  }
}

function parseReviewAction(m: Record<string, unknown>): ReviewAction | undefined {
  const id = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 500;
  const text = (v: unknown): v is string => typeof v === 'string' && v.length <= MAX_ACTION_TEXT;
  const optional = <T>(v: unknown, ok: (x: unknown) => x is T): boolean => v === undefined || ok(v);
  switch (m.type) {
    case 'setMode':
      return m.mode === 'fast' || m.mode === 'didactic' ? { type: 'setMode', mode: m.mode } : undefined;
    case 'setDepth':
      return DEPTHS.includes(m.depth as Depth) ? { type: 'setDepth', depth: m.depth as Depth } : undefined;
    case 'enter':
      return id(m.nodeId) ? { type: 'enter', nodeId: m.nodeId } : undefined;
    case 'familiarity':
      return id(m.nodeId) && (m.level === 'new' || m.level === 'some' || m.level === 'known') ? { type: 'familiarity', nodeId: m.nodeId, level: m.level } : undefined;
    case 'cancelGate':
      return { type: 'cancelGate' };
    case 'answer':
      if (!id(m.questionId) || !optional(m.choiceId, id) || !optional(m.text, text)) return undefined;
      return { type: 'answer', questionId: m.questionId, ...(m.choiceId !== undefined ? { choiceId: m.choiceId as string } : {}), ...(m.text !== undefined ? { text: m.text as string } : {}) };
    case 'selfCheck':
      return id(m.questionId) && typeof m.gotIt === 'boolean' ? { type: 'selfCheck', questionId: m.questionId, gotIt: m.gotIt } : undefined;
    case 'commentAction':
      return id(m.id) && (m.action === 'accept' || m.action === 'reject' || m.action === 'reopen') ? { type: 'commentAction', id: m.id, action: m.action } : undefined;
    case 'amend':
      return id(m.id) && text(m.body) ? { type: 'amend', id: m.id, body: m.body } : undefined;
    case 'thread':
      return id(m.id) && text(m.text) ? { type: 'thread', id: m.id, text: m.text } : undefined;
    case 'adoptProposal':
      return id(m.id) && Number.isInteger(m.index) && (m.index as number) >= 0 ? { type: 'adoptProposal', id: m.id, index: m.index as number } : undefined;
    case 'addNote':
      if (!text(m.text) || !optional(m.nodeId, id)) return undefined;
      return { type: 'addNote', text: m.text, ...(m.nodeId !== undefined ? { nodeId: m.nodeId as string } : {}) };
    case 'draftWithAgent':
    case 'post':
    case 'exportReview':
      return { type: m.type };
    default:
      return undefined;
  }
}

function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v).slice(0, 500);
  } catch {
    return String(v);
  }
}

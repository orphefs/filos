// The review webview: a bare HTML shell (the webview script builds the whole UI), a strict CSP,
// and typed messages. Messages posted before the script says "ready" would be dropped, so the host
// answers "ready" with a full snapshot instead of relying on earlier posts.

import { randomBytes } from 'node:crypto';
import * as vscode from 'vscode';
import type { HostToWebview, WebviewToHost } from '../protocol';

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
        const msg = asMessage(raw);
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

const WEBVIEW_TYPES = new Set<WebviewToHost['type']>(['ready', 'select', 'openAnchor', 'stateChanged', 'action', 'rendered']);

/** Shape check at the trust boundary: the webview is ours, but its messages are still just data. */
function asMessage(raw: unknown): WebviewToHost | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const m = raw as Record<string, unknown>;
  if (typeof m.type !== 'string' || !WEBVIEW_TYPES.has(m.type as WebviewToHost['type'])) return undefined;
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
      return ['login', 'retry', 'useFixture', 'rerun'].includes(m.action as string) ? (m as unknown as WebviewToHost) : undefined;
    case 'rendered':
      return strs(m.visibleNodes) && strs(m.expanded) ? (m as unknown as WebviewToHost) : undefined;
    default:
      return m as unknown as WebviewToHost;
  }
}

function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v).slice(0, 500);
  } catch {
    return String(v);
  }
}

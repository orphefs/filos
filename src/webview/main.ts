// Webview entry. The host page can be a bare shell: main.ts builds the whole UI inside
// <div id="app"> (or <body> if there is none), so the host only needs to provide
//   <link rel="stylesheet" href="{dist/webview.css}">
//   <body><div id="app"></div><script nonce="…" src="{dist/webview.js}"></script></body>
// No inline handlers, eval or network access: it runs under the strict webview CSP.

import type { HostToWebview } from '../protocol';
import { App } from './app';
import { post } from './vscodeApi';

const KNOWN = new Set(['loading', 'load', 'error', 'select', 'review']);

function start(): void {
  const mount = document.getElementById('app') ?? document.body;
  const app = new App(mount);
  window.addEventListener('message', (ev: MessageEvent) => {
    const msg = ev.data as HostToWebview | undefined;
    if (!msg || typeof msg !== 'object' || !KNOWN.has((msg as { type?: string }).type ?? '')) return;
    try {
      app.handle(msg);
    } catch (err) {
      console.error('[filos] failed to handle', msg.type, err);
    }
  });
  post({ type: 'ready' });
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
else start();

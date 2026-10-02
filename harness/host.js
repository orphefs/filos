// Mock extension host for the harness. Provides acquireVsCodeApi (once, like VS Code), records
// everything the webview posts in window.__hostLog and the visible "Host log", and answers the
// way the real host would: 'ready' → fetch the fixture and post 'load'.
// Loaded before dist/webview.js.

(() => {
  'use strict';

  const FIXTURE = '/fixtures/sample-graph.json';
  const STATE_KEY = 'filos-harness-webview-state';
  const HOST_STATE_KEY = 'filos-harness-host-state';
  const log = (window.__hostLog = []);
  let graph = null;
  let acquired = false;

  const read = (key) => {
    try {
      const v = sessionStorage.getItem(key);
      return v ? JSON.parse(v) : undefined;
    } catch {
      return undefined;
    }
  };
  const write = (key, v) => {
    try {
      sessionStorage.setItem(key, JSON.stringify(v));
    } catch {
      /* private mode: state just won't survive a reload */
    }
  };

  // What the real host remembers from 'stateChanged' and hands back on the next 'load'.
  let hostState = read(HOST_STATE_KEY) ?? { expanded: [], visited: [] };

  function record(direction, msg) {
    const entry = { direction, at: Date.now(), msg };
    log.push(entry);
    const list = document.getElementById('host-log');
    if (!list) return;
    const li = document.createElement('li');
    li.className = direction === 'host → webview' ? 'from-host' : 'from-webview';
    const shown = msg.type === 'load' ? { ...msg, graph: `‹${msg.graph.nodes.length} nodes›` } : msg;
    li.textContent = `${direction}  ${JSON.stringify(shown)}`;
    list.append(li);
    list.scrollTop = list.scrollHeight;
  }

  function send(msg) {
    record('host → webview', msg);
    window.postMessage(msg, '*');
  }

  async function fixture() {
    if (!graph) {
      const res = await fetch(FIXTURE, { cache: 'no-store' });
      if (!res.ok) throw new Error(`GET ${FIXTURE}: ${res.status}`);
      graph = await res.json();
      fillSelect();
    }
    return graph;
  }

  async function sendLoad(opts = {}) {
    try {
      const g = structuredClone(await fixture());
      if (opts.agent) g.generatedBy = { provider: 'claude', model: 'claude-sonnet-5', at: new Date().toISOString() };
      send({
        type: 'load',
        graph: g,
        source: opts.agent ? 'agent' : 'fixture',
        state: hostState,
        warnings: opts.warnings
          ? ['node "ext/mobile-app": externals have no anchors (ignored)', 'anchor test/round.test.ts:15-29 is in a file with no outline (no folds there)']
          : [],
      });
    } catch (err) {
      send({ type: 'error', message: 'The harness could not load the fixture.', detail: String(err), actions: ['retry'] });
    }
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  async function simulateRun() {
    send({ type: 'loading', message: 'Reading the PR…', detail: 'claude · feature/bankers-rounding → main' });
    await sleep(700);
    send({ type: 'loading', message: 'Reading money/round.ts', detail: 'claude · feature/bankers-rounding → main' });
    await sleep(700);
    await sendLoad({ agent: true });
  }

  function onWebviewMessage(msg) {
    record('webview → host', msg);
    switch (msg?.type) {
      case 'ready':
        void sendLoad();
        break;
      case 'stateChanged':
        hostState = msg.state;
        write(HOST_STATE_KEY, hostState);
        break;
      case 'action':
        if (msg.action === 'useFixture') void sendLoad();
        else void simulateRun(); // login, retry, rerun: the real host re-runs the agent
        break;
      default:
        break; // select / openAnchor / rendered: logged only (the real host opens code)
    }
  }

  window.acquireVsCodeApi = () => {
    if (acquired) throw new Error('An instance of the VS Code API has already been acquired');
    acquired = true;
    return Object.freeze({
      postMessage: (msg) => onWebviewMessage(structuredClone(msg)),
      getState: () => read(STATE_KEY),
      setState: (s) => {
        write(STATE_KEY, s);
        return s;
      },
    });
  };

  // ---- harness controls ----

  function fillSelect() {
    const sel = document.getElementById('h-select-id');
    if (!sel || !graph || sel.options.length) return;
    for (const n of graph.nodes) {
      const o = document.createElement('option');
      o.value = n.id;
      o.textContent = n.id;
      sel.append(o);
    }
    sel.value = 'money/roundToCents';
  }

  function setTheme(cls) {
    document.body.classList.remove('vscode-light', 'vscode-dark', 'vscode-high-contrast');
    document.body.classList.add(cls);
    document.body.dataset.vscodeThemeKind = cls;
    for (const b of document.querySelectorAll('[data-theme]')) b.setAttribute('aria-pressed', String(b.dataset.theme === cls));
  }

  function setWidth(px) {
    const frame = document.getElementById('harness-frame');
    if (px) {
      frame.dataset.width = px;
      frame.style.width = `${px}px`;
    } else {
      delete frame.dataset.width;
      frame.style.width = '';
    }
    for (const b of document.querySelectorAll('[data-width]')) b.setAttribute('aria-pressed', String(b.dataset.width === (px || '')));
  }

  function wire() {
    const on = (id, fn) => document.getElementById(id)?.addEventListener('click', fn);
    for (const b of document.querySelectorAll('[data-theme]')) b.addEventListener('click', () => setTheme(b.dataset.theme));
    for (const b of document.querySelectorAll('[data-width]')) b.addEventListener('click', () => setWidth(b.dataset.width));
    on('h-load', () => void sendLoad());
    on('h-load-warn', () => void sendLoad({ warnings: true }));
    on('h-load-agent', () => void sendLoad({ agent: true }));
    on('h-loading', () => send({ type: 'loading', message: 'Asking claude to read the PR…', detail: 'Reading money/round.ts' }));
    on('h-error', () =>
      send({
        type: 'error',
        message: 'The agent’s answer did not match the review-graph contract.',
        detail: '/nodes/3/risk must have required property "why"\n/edges/2/to "money/roundToCent" is not a node',
        actions: ['retry', 'useFixture', 'login'],
      }),
    );
    on('h-error-auth', () =>
      send({ type: 'error', message: 'Your claude session has expired.', detail: 'Run "claude auth login" in a terminal, then try again.', actions: ['login', 'useFixture'] }),
    );
    on('h-select', () => send({ type: 'select', id: document.getElementById('h-select-id').value }));
    on('h-log-clear', () => {
      log.length = 0;
      document.getElementById('host-log').replaceChildren();
    });
    on('h-reset', () => {
      try {
        sessionStorage.removeItem(STATE_KEY);
        sessionStorage.removeItem(HOST_STATE_KEY);
      } catch {
        /* ignore */
      }
      location.reload();
    });
    const params = new URLSearchParams(location.search);
    if (params.has('compact')) document.body.classList.add('harness-compact');
    const theme = params.get('theme');
    setTheme(theme ? `vscode-${theme}` : matchMedia('(prefers-color-scheme: dark)').matches ? 'vscode-dark' : 'vscode-light');
    setWidth('');
    void fixture().catch(() => {});
  }

  window.__filosHarness = { send, sendLoad, setTheme, setWidth };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wire, { once: true });
  else wire();
})();

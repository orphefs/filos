// A small Chrome DevTools Protocol client, so the e2e suite can use VS Code the way a person does:
// real mouse clicks and key presses on the window, DOM reads inside the review webview, and
// screenshots. runE2E.ts starts VS Code with --remote-debugging-port; the extension host runs on
// Electron's Node 22, which has fetch and WebSocket built in, so this needs no dependency.
//
// The review webview is an out-of-process iframe (vscode-webview://…/index.html) that hosts our
// page in a same-origin inner iframe (#active-frame). Input events go to the workbench page at
// window coordinates, so a click point is: inner element + #active-frame offset + webview iframe.

import { writeFileSync } from 'node:fs';

type Params = Record<string, unknown>;
type Listener = (method: string, params: any, sessionId?: string) => void;

/** The subset of the WHATWG WebSocket used here (@types/node 20 doesn't declare the global). */
interface Socket {
  send(data: string): void;
  close(): void;
  addEventListener(type: 'open' | 'message' | 'error' | 'close', fn: (ev: { data?: unknown; message?: string }) => void): void;
}

interface Target {
  id: string;
  type: string;
  url: string;
  webSocketDebuggerUrl: string;
}

export interface Point {
  x: number;
  y: number;
}

export interface PointOptions {
  /** Skip points whose hit target is inside this selector (e.g. a node's chevron). */
  avoid?: string;
  /** Among the elements matching the selector, take the one with exactly this (trimmed) text. */
  text?: string;
}

class Connection {
  private seq = 0;
  private readonly pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  private readonly listeners = new Set<Listener>();

  private constructor(private readonly ws: Socket) {
    ws.addEventListener('message', (ev) => this.onMessage(String(ev.data)));
    ws.addEventListener('close', () => {
      for (const p of this.pending.values()) p.reject(new Error('DevTools connection closed'));
      this.pending.clear();
    });
  }

  static open(url: string, timeoutMs = 10_000): Promise<Connection> {
    const Ctor = (globalThis as { WebSocket?: new (url: string) => Socket }).WebSocket;
    if (!Ctor) return Promise.reject(new Error(`no global WebSocket in this runtime (Node ${process.versions.node}); the click tests need Node 22+`));
    const ws = new Ctor(url);
    return new Promise((ok, fail) => {
      const timer = setTimeout(() => fail(new Error(`DevTools connection to ${url} timed out`)), timeoutMs);
      ws.addEventListener('open', () => {
        clearTimeout(timer);
        ok(new Connection(ws));
      });
      ws.addEventListener('error', (ev) => {
        clearTimeout(timer);
        fail(new Error(`DevTools connection to ${url} failed: ${ev.message ?? 'error'}`));
      });
    });
  }

  send<T = any>(method: string, params: Params = {}, sessionId?: string, timeoutMs = 20_000): Promise<T> {
    const id = ++this.seq;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} got no answer within ${timeoutMs} ms`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }

  on(fn: Listener): void {
    this.listeners.add(fn);
  }

  close(): void {
    this.ws.close();
  }

  private onMessage(raw: string): void {
    const m = JSON.parse(raw) as { id?: number; result?: unknown; error?: { message: string }; method?: string; params?: unknown; sessionId?: string };
    if (m.id !== undefined) {
      const p = this.pending.get(m.id);
      if (!p) return;
      this.pending.delete(m.id);
      clearTimeout(p.timer);
      if (m.error) p.reject(new Error(m.error.message));
      else p.resolve(m.result);
      return;
    }
    if (m.method) for (const fn of this.listeners) fn(m.method, m.params, m.sessionId);
  }
}

const KEYS: Record<string, { code: string; keyCode: number; text?: string }> = {
  Enter: { code: 'Enter', keyCode: 13, text: '\r' },
  ' ': { code: 'Space', keyCode: 32, text: ' ' },
  Escape: { code: 'Escape', keyCode: 27 },
  Tab: { code: 'Tab', keyCode: 9 },
  ArrowUp: { code: 'ArrowUp', keyCode: 38 },
  ArrowDown: { code: 'ArrowDown', keyCode: 40 },
  ArrowLeft: { code: 'ArrowLeft', keyCode: 37 },
  ArrowRight: { code: 'ArrowRight', keyCode: 39 },
  Home: { code: 'Home', keyCode: 36 },
  End: { code: 'End', keyCode: 35 },
};

/**
 * Runs `fn(document, window, ...args)` against the Filos page inside a webview iframe session.
 * The function is serialised, so it may only use its arguments and browser globals.
 */
function inPage(fnSource: string, args: unknown[]): string {
  return `(() => {
    const f = document.getElementById('active-frame');
    const d = f && f.contentDocument;
    if (!d || !d.querySelector('.filos')) return { __notFilos: true };
    const off = f.getBoundingClientRect();
    const frame = { left: off.left + f.clientLeft, top: off.top + f.clientTop };
    return (${fnSource})(d, f.contentWindow, frame, ...${JSON.stringify(args)});
  })()`;
}

/** The VS Code window, driven over DevTools. */
export class Workbench {
  /** Webview iframes we attached to: target id -> session id. */
  private readonly sessions = new Map<string, string>();
  private lastProbeError = '';

  private constructor(
    private readonly conn: Connection,
    private readonly port: number,
  ) {
    conn.on((method, params) => {
      if (method !== 'Target.detachedFromTarget') return;
      for (const [targetId, sessionId] of this.sessions) if (sessionId === params.sessionId) this.sessions.delete(targetId);
    });
  }

  static async connect(port: number): Promise<Workbench> {
    const list = await targets(port);
    const page = list.find((t) => t.type === 'page' && /workbench/.test(t.url));
    if (!page) throw new Error(`no VS Code workbench among the DevTools targets: ${list.map((t) => `${t.type} ${t.url}`).join(', ')}`);
    const conn = await Connection.open(page.webSocketDebuggerUrl);
    await conn.send('DOM.enable');
    return new Workbench(conn, port);
  }

  close(): void {
    this.conn.close();
  }

  async screenshot(file: string): Promise<void> {
    const { data } = await this.conn.send<{ data: string }>('Page.captureScreenshot', { format: 'png' });
    writeFileSync(file, Buffer.from(data, 'base64'));
  }

  /** Evaluates an expression in the workbench page (VS Code's own UI). */
  async evalPage<T>(expression: string): Promise<T> {
    const r = await this.conn.send<{ result: { value: T }; exceptionDetails?: { exception?: { description?: string }; text: string } }>('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (r.exceptionDetails) throw new Error(`page: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
    return r.result.value;
  }

  /**
   * Evaluates `fn(document, window, frameOffset, ...args)` in the Filos webview's page.
   * Throws if no Filos webview is attached (yet).
   */
  async evalWebview<T>(fnSource: string, ...args: unknown[]): Promise<T> {
    const found = await this.findWebview();
    if (!found) throw new Error(`the Filos webview is not on screen (${await this.describeFrames()})`);
    return this.evalIn<T>(found.sessionId, fnSource, args);
  }

  /** Polls a predicate inside the webview until it returns something truthy. */
  async waitForWebview<T>(fnSource: string, what: string, timeoutMs = 10_000, ...args: unknown[]): Promise<T> {
    const deadline = Date.now() + timeoutMs;
    let last: unknown;
    for (;;) {
      try {
        last = await this.evalWebview<T>(fnSource, ...args);
        if (last) return last as T;
      } catch (e) {
        last = e instanceof Error ? e.message : e;
      }
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${what} in the webview (last: ${JSON.stringify(last)})`);
      await sleep(100);
    }
  }

  /**
   * Clicks an element of the Filos webview with the real mouse. The point is the first one (centre
   * first) where hit-testing lands on the element itself, so a click never goes to whatever covers
   * it; `avoid` excludes parts such as a node's chevron, `text` picks among matches by their text.
   */
  async clickWebview(selector: string, opts: PointOptions = {}): Promise<Point> {
    await this.scrollIntoView(selector, opts);
    const p = await this.webviewPoint(selector, opts);
    await this.click(p);
    return p;
  }

  /**
   * Scrolls an element of the webview into view with the mouse wheel, over its scroll container
   * (never over the graph, where the wheel zooms). A no-op when it is already in view.
   */
  async scrollIntoView(selector: string, opts: PointOptions = {}): Promise<void> {
    const found = await this.findWebview();
    if (!found) throw new Error(`the Filos webview is not on screen (${await this.describeFrames()})`);
    for (let i = 0; i < 20; i++) {
      const r = await this.evalIn<{ inView: true } | { x: number; y: number; deltaY: number } | { error: string }>(found.sessionId, WHEEL_TOWARDS, [selector, opts.text ?? null]);
      if ('error' in r) throw new Error(`cannot scroll to ${selector}: ${r.error}`);
      if ('inView' in r) return;
      const owner = await this.frameOrigin(found.targetId);
      const deltaY = Math.max(-400, Math.min(400, r.deltaY));
      await this.conn.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: Math.round(owner.x + r.x), y: Math.round(owner.y + r.y), deltaX: 0, deltaY, button: 'none' });
      await sleep(120);
    }
    throw new Error(`could not scroll ${selector} into view`);
  }

  /**
   * Window coordinates of a clickable point on the element, or an error saying why there is none.
   * Waits until the point holds still: a person doesn't click a button while the layout around
   * it is still moving (a panel closing, a graph transition).
   */
  async webviewPoint(selector: string, opts: PointOptions = {}): Promise<Point> {
    const measure = () => this.toWindow(POINT_IN_ELEMENT, [selector, opts.avoid ?? null, opts.text ?? null], selector);
    let p = await measure();
    for (let i = 0; i < 20; i++) {
      await sleep(80);
      const q = await measure();
      if (q.x === p.x && q.y === p.y) return q;
      p = q;
    }
    return p;
  }

  /** Clicks empty canvas in the graph (no node, no module box under the pointer). */
  async clickGraphBackground(): Promise<Point> {
    const p = await this.toWindow(EMPTY_GRAPH_POINT, [], 'the graph background');
    await this.click(p);
    return p;
  }

  private async toWindow(fnSource: string, args: unknown[], what: string): Promise<Point> {
    const found = await this.findWebview();
    if (!found) throw new Error(`the Filos webview is not on screen (${await this.describeFrames()})`);
    const r = await this.evalIn<{ x: number; y: number } | { error: string }>(found.sessionId, fnSource, args);
    if ('error' in r) throw new Error(`cannot click ${what}: ${r.error}`);
    const owner = await this.frameOrigin(found.targetId);
    return { x: Math.round(owner.x + r.x), y: Math.round(owner.y + r.y) };
  }

  async click(p: Point, clickCount = 1): Promise<void> {
    const mouse = (type: string, extra: Params = {}) => this.conn.send('Input.dispatchMouseEvent', { type, x: p.x, y: p.y, button: 'left', ...extra });
    await mouse('mouseMoved', { button: 'none' });
    await mouse('mousePressed', { buttons: 1, clickCount });
    await mouse('mouseReleased', { buttons: 0, clickCount });
  }

  /** A key press, delivered to whatever has keyboard focus in the window. */
  async press(key: string): Promise<void> {
    const k = KEYS[key];
    if (!k) throw new Error(`press: no key mapping for "${key}"`);
    const base = { key, code: k.code, windowsVirtualKeyCode: k.keyCode, nativeVirtualKeyCode: k.keyCode };
    await this.conn.send('Input.dispatchKeyEvent', { type: k.text ? 'keyDown' : 'rawKeyDown', text: k.text, unmodifiedText: k.text, ...base });
    await this.conn.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
  }

  private async evalIn<T>(sessionId: string, fnSource: string, args: unknown[]): Promise<T> {
    const r = await this.conn.send<{ result: { value: T }; exceptionDetails?: { exception?: { description?: string }; text: string } }>(
      'Runtime.evaluate',
      { expression: inPage(fnSource, args), returnByValue: true, awaitPromise: true },
      sessionId,
    );
    if (r.exceptionDetails) throw new Error(`webview: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
    if (r.result.value && typeof r.result.value === 'object' && (r.result.value as { __notFilos?: boolean }).__notFilos) throw new Error('not the Filos webview');
    return r.result.value;
  }

  private async describeFrames(): Promise<string> {
    let list = '';
    try {
      list = (await targets(this.port)).map((t) => `${t.type} ${t.url.slice(0, 100)}`).join(' | ');
    } catch (e) {
      list = String(e);
    }
    return `targets: ${list}${this.lastProbeError ? `; last probe: ${this.lastProbeError}` : ''}`;
  }

  /**
   * The webview iframe that shows the Filos page and is laid out on screen. Webview iframes are
   * listed as their own DevTools targets; attach to each (once) to evaluate inside it.
   */
  private async findWebview(): Promise<{ sessionId: string; targetId: string } | undefined> {
    const frames = (await targets(this.port)).filter((t) => t.type === 'iframe' && t.url.startsWith('vscode-webview://')).reverse();
    for (const t of frames) {
      try {
        let sessionId = this.sessions.get(t.id);
        if (!sessionId) {
          sessionId = (await this.conn.send<{ sessionId: string }>('Target.attachToTarget', { targetId: t.id, flatten: true })).sessionId;
          this.sessions.set(t.id, sessionId);
        }
        const shown = await this.evalIn<boolean>(sessionId, '(d, w) => w.innerWidth > 0 && w.innerHeight > 0', []);
        if (shown) return { sessionId, targetId: t.id };
      } catch (e) {
        // Another extension's webview, or one being torn down.
        this.lastProbeError = e instanceof Error ? e.message : String(e);
      }
    }
    return undefined;
  }

  /** Top-left of the webview iframe's content box, in window coordinates. */
  private async frameOrigin(frameId: string): Promise<Point> {
    const { backendNodeId } = await this.conn.send<{ backendNodeId: number }>('DOM.getFrameOwner', { frameId });
    const { model } = await this.conn.send<{ model: { content: number[] } }>('DOM.getBoxModel', { backendNodeId });
    return { x: model.content[0], y: model.content[1] };
  }
}

async function targets(port: number): Promise<Target[]> {
  return (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()) as Target[];
}

// The functions below are serialised into the webview (see inPage).

/** Shared prelude: the element matching `selector` (and `text`, when given), or an error. */
const PICK = `const all = [...d.querySelectorAll(selector)];
  const el = text === null ? all[0] : all.find((e) => e.textContent.trim() === text);
  if (!el) return { error: 'no element matches' + (text === null ? '' : ' with text ' + JSON.stringify(text) + ' (found ' + JSON.stringify(all.map((e) => e.textContent.trim())) + ')') };`;

/** In view, or where to turn the wheel (and how far) to bring it there. */
const WHEEL_TOWARDS = `(d, w, frame, selector, text) => {
  ${PICK}
  const r = el.getBoundingClientRect();
  if (r.top >= 0 && r.bottom <= w.innerHeight) return { inView: true };
  for (let s = el.parentElement; s; s = s.parentElement) {
    if (!(s.scrollHeight > s.clientHeight + 1 && /(auto|scroll)/.test(getComputedStyle(s).overflowY))) continue;
    const b = s.getBoundingClientRect();
    const top = Math.max(b.top, 0), bottom = Math.min(b.bottom, w.innerHeight);
    const left = Math.max(b.left, 0), right = Math.min(b.right, w.innerWidth);
    if (bottom - top < 8 || right - left < 8) continue;
    const x = (left + right) / 2, y = (top + bottom) / 2;
    const hit = d.elementFromPoint(x, y);
    if (!hit || !s.contains(hit) || hit.closest('.graph-svg')) continue;
    return { x: frame.left + x, y: frame.top + y, deltaY: Math.round((r.top + r.bottom) / 2 - y) };
  }
  return { error: 'it is out of view and no scroll container can bring it in' };
}`;

/** A point on the element (centre first) where hit-testing lands on the element itself. */
const POINT_IN_ELEMENT = `(d, w, frame, selector, avoid, text) => {
  ${PICK}
  const r = el.getBoundingClientRect();
  if (!r.width || !r.height) return { error: 'it is not displayed' };
  const steps = [0.5, 0.35, 0.65, 0.2, 0.8, 0.1, 0.9];
  for (const fy of steps) for (const fx of steps) {
    const x = r.left + r.width * fx;
    const y = r.top + r.height * fy;
    if (x < 1 || y < 1 || x > w.innerWidth - 1 || y > w.innerHeight - 1) continue;
    const hit = d.elementFromPoint(x, y);
    if (!hit || !(hit === el || el.contains(hit))) continue;
    if (avoid && hit.closest(avoid)) continue;
    return { x: frame.left + x, y: frame.top + y };
  }
  return { error: 'it is covered or off screen (rect ' + [r.left, r.top, r.width, r.height].map(Math.round).join(',') + ', viewport ' + w.innerWidth + 'x' + w.innerHeight + ')' };
}`;

/** A point on the graph canvas with nothing drawn under it. */
const EMPTY_GRAPH_POINT = `(d, w, frame) => {
  const svg = d.querySelector('.graph-svg');
  if (!svg) return { error: 'no graph on screen' };
  const r = svg.getBoundingClientRect();
  for (let fy = 0.95; fy > 0.05; fy -= 0.05) for (let fx = 0.95; fx > 0.05; fx -= 0.05) {
    const x = r.left + r.width * fx;
    const y = r.top + r.height * fy;
    if (d.elementFromPoint(x, y) === svg) return { x: frame.left + x, y: frame.top + y };
  }
  return { error: 'the graph covers its whole canvas' };
}`;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

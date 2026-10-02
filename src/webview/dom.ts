// Tiny element builders. Attributes only (no inline handlers or style strings), so everything
// stays within the webview CSP; listeners are attached with addEventListener by the caller.

type Attrs = Record<string, string | number | boolean | undefined | null>;
type Child = Node | string | number | null | undefined | false;

function apply(el: Element, attrs: Attrs | undefined, children: Child[]): void {
  for (const [k, v] of Object.entries(attrs ?? {})) {
    if (v === undefined || v === null || v === false) continue;
    el.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    el.append(typeof c === 'number' ? String(c) : c);
  }
}

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs?: Attrs, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  apply(el, attrs, children);
  return el;
}

const SVG_NS = 'http://www.w3.org/2000/svg';

export function s<K extends keyof SVGElementTagNameMap>(tag: K, attrs?: Attrs, ...children: Child[]): SVGElementTagNameMap[K] {
  const el = document.createElementNS(SVG_NS, tag) as SVGElementTagNameMap[K];
  apply(el, attrs, children);
  return el;
}

/** A clickable element that reacts to mouse and keyboard alike. */
export function onActivate(el: HTMLElement, fn: (ev: Event) => void): void {
  el.addEventListener('click', (ev) => {
    ev.preventDefault();
    fn(ev);
  });
}

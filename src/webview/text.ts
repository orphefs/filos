// Text measurement for node sizing. SVG text can't wrap or report its size before it is in the
// document, so we measure with a canvas using the same fonts as the CSS.

let ctx: CanvasRenderingContext2D | null = null;
const cache = new Map<string, number>();

export interface Fonts {
  /** Canvas font shorthand for node labels, e.g. "600 13px <ui font>". */
  label: string;
  /** Same for code-like labels (symbols), using the editor font. */
  code: string;
  small: string;
  badge: string;
}

/** Resolve fonts from the theme variables VS Code sets on the document. */
export function resolveFonts(probe: Element): Fonts {
  const css = getComputedStyle(probe);
  const ui = css.getPropertyValue('--vscode-font-family').trim() || 'system-ui, sans-serif';
  const code = css.getPropertyValue('--vscode-editor-font-family').trim() || 'ui-monospace, monospace';
  return {
    label: `600 13px ${ui}`,
    code: `600 13px ${code}`,
    small: `11px ${ui}`,
    badge: `600 9.5px ${ui}`,
  };
}

export function measure(text: string, font: string): number {
  const key = `${font}\u0000${text}`;
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  ctx ??= document.createElement('canvas').getContext('2d');
  let w = text.length * 7.5; // fallback if canvas is unavailable
  if (ctx) {
    ctx.font = font;
    w = ctx.measureText(text).width;
  }
  cache.set(key, w);
  return w;
}

/** Shortens text with an ellipsis so it fits maxWidth. Short labels are never truncated. */
export function fit(text: string, font: string, maxWidth: number): { text: string; truncated: boolean } {
  if (measure(text, font) <= maxWidth) return { text, truncated: false };
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (measure(text.slice(0, mid) + '…', font) <= maxWidth) lo = mid;
    else hi = mid - 1;
  }
  return { text: text.slice(0, Math.max(1, lo)) + '…', truncated: true };
}

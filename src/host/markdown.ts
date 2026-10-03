// Markdown built from agent text, which the PR under review can steer. Both helpers make the text
// render literally: no images, HTML or links of its own. No vscode import, so unit tests can run it.

/**
 * `text` as an inline code span. The fence is one backtick longer than any run of backticks in
 * the text, so nothing in it can close the span early.
 */
export function codeSpan(text: string): string {
  // A blank line would end the paragraph, and the span with it: keep it to one line.
  const flat = text.replace(/\s+/g, ' ').trim();
  if (!flat) return '';
  const longest = Math.max(0, ...(flat.match(/`+/g) ?? []).map((run) => run.length));
  const fence = '`'.repeat(longest + 1);
  // The inner spaces let the text start or end with a backtick; renderers strip one on each side.
  return `${fence} ${flat} ${fence}`;
}

/**
 * `text` as plain markdown prose, on one line. Every ASCII punctuation mark is backslash-escaped
 * (CommonMark allows it for all of them), which also stops autolinks: VS Code's own appendText
 * leaves `<file:…>` and bare URLs live.
 */
export function literal(text: string): string {
  return text
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[!-\/:-@[-`{-~]/g, '\\$&');
}

// While Filos holds focus in the code editor to fold it, keys the user meant for the graph can land
// in the file. These put the file back exactly as it was, and never touch anything the user wrote
// before. No vscode import, so unit tests can drive them with a fake document.

export interface Undoable {
  text(): string;
  /** One undo / redo step on this document; false when it can't be aimed at it (focus moved). */
  undo(): Promise<boolean>;
  redo(): Promise<boolean>;
}

/**
 * Undoes until the text is `snapshot` again, at most `maxSteps()` steps (read on every step, as
 * keys can still arrive). Typing merges into undo steps, so fewer may do. A step can also reach
 * back past the snapshot (when the stray keys merged with earlier typing); then the text never
 * matches, and every step is redone, so nothing is lost. Returns whether the snapshot was restored.
 */
export async function undoBackTo(doc: Undoable, snapshot: string, maxSteps: () => number): Promise<boolean> {
  let steps = 0;
  while (steps < maxSteps() && doc.text() !== snapshot && (await doc.undo())) steps++;
  if (doc.text() === snapshot) return true;
  while (steps > 0 && (await doc.redo())) steps--;
  return false;
}

/** The single replacement that turns `now` back into `before`: offsets into `now`, and its new text. */
export function revertEdit(now: string, before: string): { start: number; end: number; text: string } {
  const shorter = Math.min(now.length, before.length);
  let start = 0;
  while (start < shorter && now.charCodeAt(start) === before.charCodeAt(start)) start++;
  let tail = 0;
  while (tail < shorter - start && now.charCodeAt(now.length - 1 - tail) === before.charCodeAt(before.length - 1 - tail)) tail++;
  return { start, end: now.length - tail, text: before.slice(start, before.length - tail) };
}

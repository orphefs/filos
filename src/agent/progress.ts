// Progress text that came from the agent (file paths, search patterns, tool names) ends up in a VS
// Code notification, which turns "[label](command:...)" into a clickable link that runs a command.
// Everything shown there goes through this first.

export const MAX_PROGRESS_CHARS = 80;

/** Removes link syntax ([ ] ( ) and backticks), collapses whitespace and controls, caps the length. */
export function safeProgressText(text: string, max = MAX_PROGRESS_CHARS): string {
  const flat = text
    .replace(/[[\]()`]/g, '')
    .replace(/[\s\x00-\x1f\x7f]+/g, ' ')
    .trim();
  return flat.length > max ? flat.slice(0, max - 1).trimEnd() + '…' : flat;
}

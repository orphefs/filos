// The review as Markdown, for Export (clipboard and an untitled document) when there's no PR to
// post to, or as a record. Accepted comments first, then drafts marked as drafts; rejected ones are
// left out. Nothing private goes in: no confidence, no familiarity, no answers.
//
// The text is read raw in an editor far more often than previewed, so prose is escaped lightly
// (only what could make links, images, HTML or emphasis) instead of every punctuation mark.
// Comment bodies are kept as written, since they are Markdown meant for the PR, and quoted line by
// line so each stays inside its own block.

import type { ReviewGraph } from '../contract/graph';
import { codeSpan } from '../host/markdown';
import { locationSpan, SEVERITY_LABEL } from './github';
import type { DraftComment, ReviewSnapshot } from './types';

/** One line of untrusted prose (a PR title, a branch name) that renders as the same text. */
export function plainText(text: string): string {
  return text
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[\\`*_[\]<>!|~&]/g, '\\$&')
    // Block starts: a heading, a list item or a setext underline. Digits can't be escaped, so "1." becomes "1\.".
    .replace(/^[#+\-=]/, '\\$&')
    .replace(/^(\d+)([.)])/, '$1\\$2');
}

/** A comment body as a block quote: every line prefixed, so nothing in it can end the quote. */
function quoted(body: string): string {
  return body
    .replace(/\r\n?/g, '\n')
    .trim()
    .split('\n')
    .map((l) => (l.trim() ? `> ${l}` : '>'))
    .join('\n');
}

function commentBlock(c: DraftComment, graph: ReviewGraph, draft: boolean): string {
  const label = SEVERITY_LABEL[c.severity] ?? 'Comment';
  const head = [draft ? `**Draft** · ${label}` : `**${label}**`];
  const where = locationSpan(c);
  if (where) head.push(where);
  const node = c.nodeId !== undefined ? graph.nodes.find((n) => n.id === c.nodeId) : undefined;
  if (node) head.push(`on ${codeSpan(node.label)}`);
  if (c.origin.kind === 'note') head.push('reviewer note');
  return `${head.join(' · ')}\n\n${quoted(c.body)}`;
}

/** Markdown of the review: accepted comments, then drafts marked as such. */
export function reviewToMarkdown(snapshot: ReviewSnapshot, graph: ReviewGraph, prTitle: string): string {
  const live = snapshot.comments.filter((c) => c.body.trim());
  const accepted = live.filter((c) => c.status === 'accepted');
  const drafts = live.filter((c) => c.status === 'draft');
  const title = plainText(prTitle) || 'Untitled change';
  const out: string[] = [`# Review: ${title}`];
  const { base, head } = graph.pr;
  if (base && head) out.push(`${codeSpan(head)} into ${codeSpan(base)}`);

  out.push(`## Comments (${accepted.length})`);
  if (accepted.length) for (const c of accepted) out.push(commentBlock(c, graph, false));
  else out.push('_No accepted comments yet._');

  if (drafts.length) {
    out.push(`## Drafts, not accepted (${drafts.length})`);
    for (const c of drafts) out.push(commentBlock(c, graph, true));
  }
  return out.join('\n\n') + '\n';
}

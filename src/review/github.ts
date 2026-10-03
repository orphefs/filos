// Turning accepted comments into one GitHub pull-request review: which comments can sit inline
// (their head line is inside the PR's diff) and which go into the review body instead. Pure; the
// host shows the confirmation and runs `gh api`.

import type { CommentSeverity } from '../contract/questions';
import { codeSpan } from '../host/markdown';
import type { DraftComment } from './types';

/**
 * Head-side (RIGHT) line numbers each file's hunks show, context and added lines alike: GitHub
 * accepts an inline review comment only on those. Deleted files have none; renames are keyed by
 * the new path. Expects git's a/ b/ prefixes (src/host/git.ts passes them explicitly).
 */
export function diffHeadLines(diff: string): Map<string, Set<number>> {
  const out = new Map<string, Set<number>>();
  const lines = diff.split('\n');
  let path: string | undefined;
  let oldLeft = 0;
  let newLeft = 0;
  let line = 0;
  for (const raw of lines) {
    // Inside a hunk the counts, not the text, say where it ends: a removed line may start "---".
    if (oldLeft > 0 || newLeft > 0) {
      const c = raw[0];
      if (c === '\\') continue; // "\ No newline at end of file"
      if (c === '+' && newLeft > 0) {
        if (path) out.get(path)!.add(line);
        line++;
        newLeft--;
        continue;
      }
      if (c === '-' && oldLeft > 0) {
        oldLeft--;
        continue;
      }
      if ((c === ' ' || raw === '' || raw === '\r') && oldLeft > 0 && newLeft > 0) {
        // Some tools strip the space from blank context lines.
        if (path) out.get(path)!.add(line);
        line++;
        oldLeft--;
        newLeft--;
        continue;
      }
      // Malformed hunk (counts disagree with the lines): stop counting and read it as a header.
      oldLeft = newLeft = 0;
    }
    if (raw.startsWith('diff --git ')) {
      path = undefined;
    } else if (raw.startsWith('+++ ')) {
      path = headPath(raw.slice(4));
      if (path && !out.has(path)) out.set(path, new Set());
    } else if (raw.startsWith('@@ ')) {
      const m = /^@@ -\d+(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(raw);
      if (!m) continue;
      oldLeft = m[1] === undefined ? 1 : Number(m[1]);
      line = Number(m[2]);
      newLeft = m[3] === undefined ? 1 : Number(m[3]);
    }
  }
  for (const [p, set] of out) if (!set.size) out.delete(p);
  return out;
}

/** The path on a "+++ " line: quoted or plain, without the b/ prefix; undefined for /dev/null. */
function headPath(text: string): string | undefined {
  let p: string;
  if (text.startsWith('"')) {
    const unq = unquoteC(text);
    if (unq === undefined) return undefined;
    p = unq;
  } else {
    // git appends a tab to names containing spaces; other diffs append "\t<timestamp>".
    const tab = text.indexOf('\t');
    p = (tab >= 0 ? text.slice(0, tab) : text).replace(/\r$/, '');
  }
  if (p === '/dev/null') return undefined;
  return p.startsWith('b/') ? p.slice(2) : p;
}

const C_ESCAPES: Record<string, number> = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13, '"': 34, '\\': 92 };

/** git's C-style quoting ("b/caf\303\251.ts"): escapes and octal UTF-8 bytes. */
function unquoteC(text: string): string | undefined {
  const bytes: number[] = [];
  const enc = new TextEncoder();
  for (let i = 1; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"') return new TextDecoder().decode(new Uint8Array(bytes));
    if (ch !== '\\') {
      bytes.push(...enc.encode(ch));
      continue;
    }
    const next = text[++i];
    if (next === undefined) return undefined;
    if (/[0-7]/.test(next)) {
      const oct = /^[0-7]{1,3}/.exec(text.slice(i))![0];
      bytes.push(parseInt(oct, 8) & 0xff);
      i += oct.length - 1;
    } else if (next in C_ESCAPES) {
      bytes.push(C_ESCAPES[next]);
    } else {
      bytes.push(...enc.encode(next));
    }
  }
  return undefined; // unterminated
}

export const SEVERITY_LABEL: Readonly<Record<CommentSeverity, string>> = {
  blocking: 'Blocking',
  suggestion: 'Suggestion',
  question: 'Question',
  nit: 'Nit',
};

/** "**Blocking:** body" — the severity as a short prefix, as posted. */
export function commentText(c: Pick<DraftComment, 'severity' | 'body'>): string {
  return `**${SEVERITY_LABEL[c.severity] ?? 'Comment'}:** ${c.body.trim()}`;
}

/** "`src/x.ts:12`", "`src/x.ts`" or "" — a code span, so a hostile path can't inject markdown. */
export function locationSpan(c: Pick<DraftComment, 'file' | 'line'>): string {
  if (!c.file) return '';
  return codeSpan(c.line ? `${c.file}:${c.line}` : c.file);
}

export interface GithubReviewComment {
  path: string;
  line: number;
  side: 'RIGHT';
  body: string;
}

/** The payload for POST repos/{owner}/{repo}/pulls/{n}/reviews, minus `event` (the host adds COMMENT). */
export interface GithubReview {
  /** Comments that can't sit inline, as "`file:line`: …" paragraphs. Empty when all are inline. */
  body: string;
  comments: GithubReviewComment[];
}

/**
 * Accepted comments only. Inline when `file:line` is a head line of the diff (and `mayInline` allows
 * it, e.g. the comment's line refers to the diff's own commit), else in the body.
 */
export function buildGithubReview(comments: readonly DraftComment[], headLines: ReadonlyMap<string, ReadonlySet<number>>, mayInline: (c: DraftComment) => boolean = () => true): GithubReview {
  const inline: GithubReviewComment[] = [];
  const general: string[] = [];
  for (const c of comments) {
    if (c.status !== 'accepted' || !c.body.trim()) continue;
    const text = commentText(c);
    if (c.file && c.line && Number.isInteger(c.line) && headLines.get(c.file)?.has(c.line) && mayInline(c)) {
      inline.push({ path: c.file, line: c.line, side: 'RIGHT', body: text });
    } else {
      const where = locationSpan(c);
      general.push(where ? `${where}: ${text}` : text);
    }
  }
  return { body: general.join('\n\n'), comments: inline };
}

export interface GithubRepo {
  host: string;
  owner: string;
  repo: string;
}

/** owner/repo of a GitHub remote (https or ssh), or undefined for anything that isn't one. */
export function parseGithubRemote(url: string, hosts: readonly string[] = ['github.com']): GithubRepo | undefined {
  const text = url.trim();
  let host: string;
  let path: string;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) {
    try {
      const u = new URL(text);
      host = u.hostname;
      path = u.pathname;
    } catch {
      return undefined;
    }
  } else {
    const scp = /^(?:[^@/\s]+@)?([^:/\s]+):(?!\/\/)(.+)$/.exec(text);
    if (!scp) return undefined;
    host = scp[1];
    path = scp[2];
  }
  host = host.toLowerCase();
  if (!hosts.includes(host)) return undefined;
  const m = /^\/*([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+?)(?:\.git)?\/*$/.exec(path);
  if (!m || m[2] === '.' || m[2] === '..') return undefined;
  return { host, owner: m[1], repo: m[2] };
}

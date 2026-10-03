// Comment cards and the Comments tab: accept / reject / amend each draft, or discuss it with the
// agent; the reviewer's own notes (the escape hatch); asking the agent for more drafts; and posting
// or exporting. Bodies are Markdown meant for the PR, shown here as plain text. Nothing posts
// without the host's own confirmation.

import { SEVERITY_LABEL } from '../review/github';
import type { DraftComment } from '../review/types';
import { h } from './dom';
import { costNote, isPosted, nodeLabel, paneButton, spinnerLine, uid, type PaneContext } from './paneContext';


function origin(c: DraftComment, ctx: PaneContext): string {
  switch (c.origin.kind) {
    case 'question': {
      const qid = c.origin.questionId;
      const q = ctx.review.questions.find((x) => x.id === qid);
      return q ? `From your call on: ${oneLine(q.prompt, 90)}` : 'From your answers';
    }
    case 'agent':
      return 'Drafted by Claude Code from your answers';
    case 'note':
      return 'Your note';
  }
}

/** Why the agent's buttons are disabled: only agent-sourced reviews have an agent (the sample doesn't). */
const NO_AGENT = 'This review has no agent: it is the hand-written sample. Open it with “Review Sample PR with Agent” to work with Claude Code.';

/** The agent note under a button: its cost, or why it can't be used here. */
function agentNote(ctx: PaneContext, id: string): HTMLElement {
  return ctx.review.agentAvailable ? costNote(id) : h('span', { class: 'muted small no-agent-note', id }, NO_AGENT);
}

function oneLine(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

export function commentCard(c: DraftComment, ctx: PaneContext): HTMLElement {
  const titleId = uid('ct');
  const card = h('article', { class: `ccard ccard--${c.status}`, 'data-comment-id': c.id, 'data-status': c.status, 'aria-labelledby': titleId, tabindex: -1, 'data-focus-key': `c:${c.id}` });
  const amending = ctx.ui.amending.has(c.id);

  // Head: severity, where, and where it came from.
  const head = h('div', { class: 'ccard-head', id: titleId });
  head.append(h('span', { class: `sev sev--${c.severity}` }, SEVERITY_LABEL[c.severity] ?? 'Comment'));
  const where = c.file ? `${c.file}${c.line ? `:${c.line}` : ''}` : c.nodeId !== undefined ? nodeLabel(ctx, c.nodeId) : 'General';
  if (c.nodeId !== undefined && ctx.model.byId.has(c.nodeId)) {
    head.append(paneButton(where, `c:${c.id}:loc`, () => ctx.selectNode(c.nodeId!), { class: `loc${c.file ? ' loc--file' : ''}`, 'aria-label': `${where}: show in the graph` }));
  } else {
    head.append(h('span', { class: `loc loc--static${c.file ? ' loc--file' : ''}` }, where));
  }
  if (c.amended) head.append(h('span', { class: 'ctag' }, 'Edited'));
  if (isPosted(c, ctx.ui)) head.append(h('span', { class: 'ctag ctag--posted' }, 'Posted'));
  card.append(head);
  card.append(h('p', { class: 'ccard-origin' }, origin(c, ctx)));

  if (c.status !== 'draft') {
    const word = c.status === 'accepted' ? '✓ Accepted' : '✗ Rejected';
    card.append(
      h(
        'p',
        { class: `ccard-status status--${c.status}` },
        h('strong', {}, word),
        c.status === 'accepted' ? ' Will be posted.' : ' Won’t be posted.',
        ' ',
        paneButton('Undo', `c:${c.id}:undo`, () => ctx.act({ type: 'commentAction', id: c.id, action: 'reopen' }, [`c:${c.id}:accept`, `c:${c.id}`]), {
          class: 'link-button',
          'aria-label': `Undo: make this comment a draft again`,
        }),
      ),
    );
  }

  if (amending) {
    card.append(amendEditor(c, ctx));
  } else {
    card.append(h('div', { class: 'ccard-body' }, c.body));
  }

  if (c.status !== 'rejected' && !amending) {
    const row = h('div', { class: 'button-row ccard-actions' });
    if (c.status === 'draft') {
      row.append(
        paneButton('Accept', `c:${c.id}:accept`, () => ctx.act({ type: 'commentAction', id: c.id, action: 'accept' }, [`c:${c.id}:undo`]), { class: 'primary', 'aria-describedby': titleId }),
        paneButton('Reject', `c:${c.id}:reject`, () => ctx.act({ type: 'commentAction', id: c.id, action: 'reject' }, [`c:${c.id}:undo`]), { 'aria-describedby': titleId }),
      );
    }
    row.append(
      paneButton('Amend', `c:${c.id}:amend`, () => {
        ctx.ui.amending.add(c.id);
        if (!ctx.drafts.get(`amend:${c.id}`)) ctx.drafts.set(`amend:${c.id}`, c.body);
        ctx.rerender([`amend:${c.id}`]);
      }),
    );
    const open = ctx.ui.openThreads.has(c.id);
    const n = c.thread.length;
    row.append(
      paneButton(n ? `Discuss (${n})` : 'Discuss', `c:${c.id}:discuss`, () => {
        if (open) ctx.ui.openThreads.delete(c.id);
        else ctx.ui.openThreads.add(c.id);
        ctx.rerender(open ? [`c:${c.id}:discuss`] : [`thread:${c.id}`]);
      }, { 'aria-expanded': open ? 'true' : 'false' }),
    );
    card.append(row);
  }

  if (ctx.ui.openThreads.has(c.id) && c.status !== 'rejected') card.append(thread(c, ctx));
  return card;
}

function amendEditor(c: DraftComment, ctx: PaneContext): HTMLElement {
  const key = `amend:${c.id}`;
  const ta = ctx.drafts.textarea(key, { class: 'amend-input', rows: 4, 'aria-label': 'Comment text' });
  if (!ta.value) ta.value = c.body;
  const close = (focus: string) => {
    ctx.ui.amending.delete(c.id);
    ctx.drafts.clear(key);
    ctx.rerender([focus]);
  };
  const save = paneButton('Save', `c:${c.id}:save`, () => {
    const body = ta.value.trim();
    if (!body) {
      ctx.announce('A comment needs some text. Reject it instead to leave it out.');
      ta.focus();
      return;
    }
    ctx.ui.amending.delete(c.id);
    ctx.drafts.clear(key);
    ctx.act({ type: 'amend', id: c.id, body }, [`c:${c.id}:amend`]);
  }, { class: 'primary' });
  ta.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape') {
      ev.preventDefault();
      ev.stopPropagation();
      close(`c:${c.id}:amend`);
    } else if (ev.key === 'Enter' && (ev.ctrlKey || ev.metaKey)) {
      ev.preventDefault();
      save.click();
    }
  });
  return h('div', { class: 'amend-box' }, ta, h('div', { class: 'button-row' }, save, paneButton('Cancel', `c:${c.id}:cancel`, () => close(`c:${c.id}:amend`))));
}

function thread(c: DraftComment, ctx: PaneContext): HTMLElement {
  const box = h('section', { class: 'thread', 'aria-label': 'Discussion with Claude Code' });
  if (c.thread.length) {
    const list = h('ol', { class: 'thread-list' });
    c.thread.forEach((m, i) => {
      const li = h('li', { class: `msg msg--${m.role}` }, h('p', { class: 'msg-who' }, m.role === 'user' ? 'You' : 'Claude Code'), h('p', { class: 'msg-text' }, m.text));
      if (m.role === 'agent' && m.proposal) {
        const inUse = m.proposal.trim() === c.body.trim();
        li.append(
          h(
            'div',
            { class: 'proposal' },
            h('p', { class: 'mini-label' }, 'Proposed comment'),
            h('blockquote', {}, m.proposal),
            inUse
              ? h('p', { class: 'ctag ctag--inuse' }, '✓ In use')
              : paneButton('Use this version', `c:${c.id}:adopt:${i}`, () => ctx.act({ type: 'adoptProposal', id: c.id, index: i }, [`c:${c.id}:adopt:${i}`, `thread:${c.id}`]), { class: 'secondary' }),
          ),
        );
      }
      list.append(li);
    });
    box.append(list);
  } else if (ctx.review.agentAvailable) {
    box.append(h('p', { class: 'muted small' }, 'Ask Claude Code to sharpen this comment, check a claim, or say it more kindly. It can propose a rewrite you can use.'));
  }
  if (c.threadPending) box.append(spinnerLine('Claude is replying…'));

  const key = `thread:${c.id}`;
  const noteId = uid('cost');
  const ta = ctx.drafts.textarea(key, { class: 'thread-input', rows: 2, 'aria-label': 'Message to Claude Code about this comment', placeholder: 'e.g. Make this shorter and suggest a fix' });
  const send = paneButton('Send', `c:${c.id}:send`, () => {
    const text = ctx.drafts.get(key).trim();
    if (!text) {
      ta.focus();
      return;
    }
    const before = c.thread.length;
    // Kept until the message shows up in the thread: the host may not send it (no agent).
    ctx.drafts.clearOnceArrived(key, (review) => (review.comments.find((x) => x.id === c.id)?.thread.length ?? 0) > before);
    ctx.act({ type: 'thread', id: c.id, text }, [key]);
  }, { class: 'primary', 'aria-describedby': noteId, 'aria-disabled': c.threadPending || !ctx.review.agentAvailable ? 'true' : undefined });
  ta.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter' && (ev.ctrlKey || ev.metaKey)) {
      ev.preventDefault();
      send.click();
    }
  });
  box.append(h('div', { class: 'thread-compose' }, ta, h('div', { class: 'button-row' }, send, agentNote(ctx, noteId))));
  return box;
}

/** The Comments tab: the cards, the note box, agent drafting, then posting and export. */
export function commentsPanel(ctx: PaneContext): Node[] {
  const { review } = ctx;
  const out: Node[] = [];
  const cs = review.comments;
  const drafts = cs.filter((c) => c.status === 'draft').length;
  const accepted = cs.filter((c) => c.status === 'accepted');
  const rejected = cs.filter((c) => c.status === 'rejected').length;

  out.push(
    h(
      'div',
      { class: 'pane-head' },
      h('h2', { class: 'pane-title' }, 'Comments'),
      h('p', { class: 'pane-sub' }, cs.length ? `${drafts} to decide · ${accepted.length} accepted · ${rejected} rejected` : 'Nothing drafted yet'),
    ),
  );
  if (!cs.length) {
    out.push(
      h(
        'p',
        { class: 'muted empty-note' },
        'Your answers to “Your call” questions draft comments here. Add your own note below for anything the questions didn’t cover.',
      ),
    );
  }
  const list = h('div', { class: 'ccard-list' });
  for (const c of cs) list.append(commentCard(c, ctx));
  out.push(list);

  out.push(noteBox(ctx), agentBox(ctx), postBox(ctx));
  return out;
}

function noteBox(ctx: PaneContext): HTMLElement {
  const key = 'note';
  const headId = uid('nh');
  const sel = ctx.selected && ctx.model.byId.get(ctx.selected);
  const ta = ctx.drafts.textarea(key, { class: 'note-input', rows: 3, 'aria-labelledby': headId, placeholder: 'Anything the questions missed' });
  const add = paneButton('Add note', 'note:add', () => {
    const text = ctx.drafts.get(key).trim();
    if (!text) {
      ta.focus();
      return;
    }
    const before = ctx.review.comments.length;
    ctx.drafts.clearOnceArrived(key, (review) => review.comments.length > before);
    ctx.act({ type: 'addNote', text, ...(sel ? { nodeId: sel.id } : {}) }, ['note']);
    ctx.announce('Added your note as a draft comment.');
  }, { class: 'secondary' });
  ta.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter' && (ev.ctrlKey || ev.metaKey)) {
      ev.preventDefault();
      add.click();
    }
  });
  return h(
    'section',
    { class: 'pane-section note-box', 'aria-labelledby': headId },
    h('h3', { id: headId }, 'Add a note'),
    h('p', { class: 'muted small' }, sel ? `It becomes a draft comment on ${sel.label}, the selected node.` : 'It becomes a general draft comment. Select a node first to attach it there.'),
    ta,
    h('div', { class: 'button-row' }, add),
  );
}

function agentBox(ctx: PaneContext): HTMLElement {
  const noteId = uid('cost');
  const sec = h('section', { class: 'pane-section agent-box', 'aria-label': 'Draft comments with Claude Code' });
  const busy = !!ctx.review.draftingPending;
  // The button stays while the agent works (disabled), so keyboard focus has somewhere to stay.
  sec.append(
    h(
      'div',
      { class: 'button-row' },
      paneButton(busy ? 'Drafting…' : 'Draft comments with agent', 'draft:agent', () => ctx.act({ type: 'draftWithAgent' }, ['draft:agent']), {
        'aria-describedby': noteId,
        'aria-disabled': busy || !ctx.review.agentAvailable ? 'true' : undefined,
      }),
      agentNote(ctx, noteId),
    ),
    busy
      ? spinnerLine('Claude is drafting comments from your answers…')
      : h('p', { class: 'muted small' }, 'Turns your answers so far into draft comments you can accept, change or drop.'),
  );
  return sec;
}

function postBox(ctx: PaneContext): HTMLElement {
  const { review } = ctx;
  const post = review.post;
  const headId = uid('ph');
  const target = post.target;
  const readyIds = review.comments.filter((c) => c.status === 'accepted' && c.body.trim() && !isPosted(c, ctx.ui)).map((c) => c.id);
  const ready = readyIds.length;
  const reasonId = uid('pr');
  const sec = h('section', { class: 'pane-section post-box', 'aria-labelledby': headId });
  sec.append(h('h3', { id: headId }, 'Post the review'));
  if (target.kind === 'github') {
    sec.append(h('p', { class: 'post-target', id: reasonId }, `To pull request #${target.number} in ${target.repo}`, h('span', { class: 'post-url' }, target.url)));
  } else {
    sec.append(h('p', { class: 'post-target post-target--none', id: reasonId }, target.reason || 'There is no pull request to post to.'));
  }
  const busy = post.status === 'posting';
  const canPost = target.kind === 'github' && ready > 0 && !busy;
  const posted = review.comments.filter((c) => isPosted(c, ctx.ui)).length;
  const label = ready === 1 ? 'Post 1 accepted comment' : ready || !posted ? `Post ${ready} accepted comments` : 'Nothing new to post';
  sec.append(
    h(
      'div',
      { class: 'button-row' },
      paneButton(label, 'post:go', () => {
        ctx.ui.postingIds = readyIds;
        ctx.act({ type: 'post' }, ['post:go']);
      }, {
        class: 'primary',
        'aria-disabled': canPost ? undefined : 'true',
        'aria-describedby': reasonId,
      }),
      paneButton('Export as Markdown', 'post:export', () => ctx.act({ type: 'exportReview' }, ['post:export'])),
    ),
  );
  if (target.kind === 'github') sec.append(h('p', { class: 'muted small' }, 'You confirm before anything is posted. Only accepted comments go.'));
  else sec.append(h('p', { class: 'muted small' }, 'Export copies the accepted comments (and the drafts, marked as drafts) as Markdown.'));

  if (post.status === 'posting') sec.append(spinnerLine('Posting to GitHub…'));
  else if (post.status === 'posted') sec.append(h('p', { class: 'notice notice--ok', role: 'status' }, '✓ Posted. ', post.url ? h('span', { class: 'post-url' }, post.url) : null));
  else if (post.status === 'error') sec.append(h('p', { class: 'notice notice--error', role: 'alert' }, `Couldn’t post: ${post.error || 'unknown error'}`));
  return sec;
}

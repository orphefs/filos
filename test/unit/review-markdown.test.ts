import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, it } from 'node:test';
import type { ReviewGraph } from '../../src/contract/graph';
import { plainText, reviewToMarkdown } from '../../src/review/markdown';
import type { DraftComment, ReviewSnapshot } from '../../src/review/types';

const FIXTURES = resolve(__dirname, '../../fixtures');
const graph = JSON.parse(readFileSync(join(FIXTURES, 'sample-graph.json'), 'utf8')) as ReviewGraph;

const comment = (over: Partial<DraftComment>): DraftComment => ({
  id: 'c1',
  body: 'Body.',
  severity: 'suggestion',
  origin: { kind: 'note' },
  status: 'accepted',
  amended: false,
  thread: [],
  ...over,
});

function snapshotWith(comments: DraftComment[]): ReviewSnapshot {
  return {
    mode: 'didactic',
    depth: { proposed: 'standard', why: 'x', chosen: 'standard' },
    questions: [],
    answers: {},
    comments,
    territories: [{ nodeId: 'money', explored: true, familiarity: 'new', confidence: 0.4242, questionsDone: 1, questionsTotal: 4 }],
    coverage: { explored: 1, total: 4 },
    questionsStatus: { state: 'ready' },
    agentAvailable: false,
    post: { target: { kind: 'none', reason: 'Sample' }, status: 'idle' },
  };
}

describe('reviewToMarkdown', () => {
  it('lists accepted comments, then drafts marked as drafts, and leaves rejected ones out', () => {
    const md = reviewToMarkdown(
      snapshotWith([
        comment({ id: 'c1', status: 'draft', severity: 'question', file: 'src/money/round.ts', line: 18, nodeId: 'money/roundToCents', origin: { kind: 'question', questionId: 'q', choiceId: 'ask' }, body: 'Is this intended?' }),
        comment({ id: 'c2', status: 'accepted', severity: 'blocking', file: 'src/money/round.ts', line: 18, nodeId: 'money/roundToCents', origin: { kind: 'question', questionId: 'q', choiceId: 'keep' }, body: 'Please keep half-up.\n\n12.5 cents now rounds to 12.' }),
        comment({ id: 'c3', status: 'rejected', body: 'Never mind.' }),
        comment({ id: 'c4', status: 'accepted', severity: 'nit', body: 'Thanks for the tests.' }),
        comment({ id: 'c5', status: 'accepted', body: '   ' }),
      ]),
      graph,
      "Switch to banker's rounding and add invoice discounts",
    );
    assert.equal(
      md,
      [
        "# Review: Switch to banker's rounding and add invoice discounts",
        '',
        '` feature/bankers-rounding ` into ` main `',
        '',
        '## Comments (2)',
        '',
        '**Blocking** · ` src/money/round.ts:18 ` · on ` roundToCents() `',
        '',
        '> Please keep half-up.',
        '>',
        '> 12.5 cents now rounds to 12.',
        '',
        '**Nit** · reviewer note',
        '',
        '> Thanks for the tests.',
        '',
        '## Drafts, not accepted (1)',
        '',
        '**Draft** · Question · ` src/money/round.ts:18 ` · on ` roundToCents() `',
        '',
        '> Is this intended?',
        '',
      ].join('\n'),
    );
  });

  it('says so when nothing is accepted, and has no drafts section without drafts', () => {
    const md = reviewToMarkdown(snapshotWith([comment({ status: 'rejected' })]), graph, 'Title');
    assert.match(md, /## Comments \(0\)\n\n_No accepted comments yet\._\n$/);
    assert.doesNotMatch(md, /Drafts/);
  });

  it('carries nothing private: no confidence, familiarity or answers', () => {
    const md = reviewToMarkdown(snapshotWith([comment({})]), graph, 'Title');
    assert.doesNotMatch(md, /confiden|familiar|0\.42|explored|1 of 4/i);
  });

  it('keeps a hostile title literal and a hostile body inside its quote', () => {
    const md = reviewToMarkdown(snapshotWith([comment({ body: 'line one\n# Not a heading\r\n\n---\n<img src=x>' })]), graph, '![x](https://evil.example/p.png) <b>hi</b>\n# two');
    const lines = md.split('\n');
    assert.equal(lines[0], '# Review: \\!\\[x\\](https://evil.example/p.png) \\<b\\>hi\\</b\\> # two');
    const quote = lines.slice(lines.indexOf('**Suggestion** · reviewer note') + 2, -1);
    assert.deepEqual(quote, ['> line one', '> # Not a heading', '>', '> ---', '> <img src=x>']);
  });

  it('falls back to a placeholder title and copes with unknown nodes', () => {
    const md = reviewToMarkdown(snapshotWith([comment({ nodeId: 'ghost' })]), graph, '   ');
    assert.ok(md.startsWith('# Review: Untitled change\n'));
    assert.match(md, /\*\*Suggestion\*\* · reviewer note\n/);
  });
});

describe('plainText', () => {
  it('escapes only what could become markup, on one line', () => {
    assert.equal(plainText("banker's rounding (v2) — 50% off"), "banker's rounding (v2) — 50% off");
    assert.equal(plainText('a *b* _c_ `d` [e](f) <g> !h | ~i~ &amp; \\'), 'a \\*b\\* \\_c\\_ \\`d\\` \\[e\\](f) \\<g\\> \\!h \\| \\~i\\~ \\&amp; \\\\');
    assert.equal(plainText('  # heading\n\nnext  '), '\\# heading next');
    assert.equal(plainText('1. item'), '1\\. item');
    assert.equal(plainText('- item'), '\\- item');
  });
});

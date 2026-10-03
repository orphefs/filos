import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, it } from 'node:test';
import type { QuestionSet } from '../../src/contract/questions';
import { buildGithubReview, commentText, diffHeadLines, locationSpan, parseGithubRemote } from '../../src/review/github';
import type { DraftComment } from '../../src/review/types';

const FIXTURES = resolve(__dirname, '../../fixtures');

const sorted = (m: Map<string, Set<number>>) => Object.fromEntries([...m].map(([k, v]) => [k, [...v].sort((a, b) => a - b)]));

/** The sample PR's diff, with paths made repo-relative (git diff --no-index prefixes base/ and head/). */
function sampleHeadLines(): Map<string, Set<number>> {
  const out = spawnSync('git', ['diff', '--no-index', '--no-ext-diff', '--no-color', '--src-prefix=a/', '--dst-prefix=b/', 'base', 'head'], { cwd: join(FIXTURES, 'sample-repo'), encoding: 'utf8' });
  assert.equal(out.status, 1, `git diff --no-index should report differences: ${out.stderr}`);
  const lines = diffHeadLines(out.stdout);
  return new Map([...lines].map(([k, v]) => [k.replace(/^head\//, ''), v]));
}

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

describe('diffHeadLines', () => {
  it('collects head-side context and added lines of each hunk, not removed ones', () => {
    const diff = [
      'diff --git a/src/a.ts b/src/a.ts',
      'index 1111111..2222222 100644',
      '--- a/src/a.ts',
      '+++ b/src/a.ts',
      '@@ -10,4 +10,5 @@ export function a() {',
      ' context 10',
      '-removed',
      '+added 11',
      '+added 12',
      ' context 13',
      ' context 14',
      '@@ -40 +41,2 @@',
      '-old',
      '+new 41',
      '+new 42',
      '',
    ].join('\n');
    assert.deepEqual(sorted(diffHeadLines(diff)), { 'src/a.ts': [10, 11, 12, 13, 14, 41, 42] });
  });

  it('handles new, deleted and renamed files', () => {
    const diff = [
      'diff --git a/src/new.ts b/src/new.ts',
      'new file mode 100644',
      'index 0000000..3333333',
      '--- /dev/null',
      '+++ b/src/new.ts',
      '@@ -0,0 +1,2 @@',
      '+line 1',
      '+line 2',
      'diff --git a/src/gone.ts b/src/gone.ts',
      'deleted file mode 100644',
      '--- a/src/gone.ts',
      '+++ /dev/null',
      '@@ -1,2 +0,0 @@',
      '-line 1',
      '-line 2',
      'diff --git a/src/old.ts b/src/renamed.ts',
      'similarity index 90%',
      'rename from src/old.ts',
      'rename to src/renamed.ts',
      '--- a/src/old.ts',
      '+++ b/src/renamed.ts',
      '@@ -3,2 +3,2 @@',
      ' same 3',
      '-was',
      '+now 4',
      'diff --git a/src/moved.ts b/src/elsewhere.ts',
      'similarity index 100%',
      'rename from src/moved.ts',
      'rename to src/elsewhere.ts',
      '',
    ].join('\n');
    assert.deepEqual(sorted(diffHeadLines(diff)), { 'src/new.ts': [1, 2], 'src/renamed.ts': [3, 4] });
  });

  it('skips "\\ No newline at end of file" and counts lines, so "---" and "+++" inside a hunk are content', () => {
    const diff = [
      '--- a/doc.md',
      '+++ b/doc.md',
      '@@ -1,3 +1,3 @@',
      '--- old rule',
      '+++ new heading',
      ' kept',
      '-last',
      '\\ No newline at end of file',
      '+last!',
      '\\ No newline at end of file',
      '',
    ].join('\n');
    assert.deepEqual(sorted(diffHeadLines(diff)), { 'doc.md': [1, 2, 3] });
  });

  it('reads quoted, tab-terminated and CRLF paths, and hunks without counts', () => {
    const diff = [
      'diff --git "a/caf\\303\\251.ts" "b/caf\\303\\251.ts"',
      '--- "a/caf\\303\\251.ts"',
      '+++ "b/caf\\303\\251.ts"',
      '@@ -1 +1 @@',
      '-x',
      '+y',
      'diff --git a/my file.ts b/my file.ts',
      '--- a/my file.ts\t',
      '+++ b/my file.ts\t',
      '@@ -1,2 +1,2 @@',
      ' one',
      '-two',
      '+TWO',
      '--- a/win.ts\r',
      '+++ b/win.ts\r',
      '@@ -5,1 +5,1 @@\r',
      '-a\r',
      '+b\r',
      '',
    ].join('\n');
    assert.deepEqual(sorted(diffHeadLines(diff)), { 'café.ts': [1], 'my file.ts': [1, 2], 'win.ts': [5] });
  });

  it('treats a blank line inside a hunk as context (some tools strip the space)', () => {
    const diff = ['--- a/x.ts', '+++ b/x.ts', '@@ -1,3 +1,3 @@', ' a', '', '-b', '+c', ''].join('\n');
    assert.deepEqual(sorted(diffHeadLines(diff)), { 'x.ts': [1, 2, 3] });
  });

  it('survives garbage', () => {
    assert.deepEqual(sorted(diffHeadLines('')), {});
    assert.deepEqual(sorted(diffHeadLines('not a diff\n@@ nonsense @@\n+++\n')), {});
    assert.deepEqual(sorted(diffHeadLines('+++ b/x.ts\n@@ -1,5 +1,5 @@\n+only one\nstray text\n')), { 'x.ts': [1] }, 'a hunk that ends early stops counting');
  });

  it('covers every line the sample questions comment on', () => {
    const lines = sampleHeadLines();
    assert.ok(lines.get('src/money/round.ts')?.has(18));
    assert.ok(!lines.has('package.json') || !lines.get('package.json')!.has(9999));
    const set = JSON.parse(readFileSync(join(FIXTURES, 'sample-questions.json'), 'utf8')) as QuestionSet;
    for (const q of set.questions) {
      for (const c of q.choices ?? []) {
        if (!c.comment?.file || !c.comment.line) continue;
        assert.ok(lines.get(c.comment.file)?.has(c.comment.line), `${q.id}/${c.id}: ${c.comment.file}:${c.comment.line} is in the diff`);
      }
    }
  });
});

describe('buildGithubReview', () => {
  const head = new Map([['src/money/round.ts', new Set([17, 18, 19])]]);

  it('posts accepted comments only: inline on diff lines, the rest in the body', () => {
    const review = buildGithubReview(
      [
        comment({ id: 'c1', file: 'src/money/round.ts', line: 18, severity: 'blocking', body: ' Keep half-up. ' }),
        comment({ id: 'c2', file: 'src/money/round.ts', line: 3, severity: 'question', body: 'Why this import?' }),
        comment({ id: 'c3', file: 'src/tax/vat.ts', severity: 'nit', body: 'Typo.' }),
        comment({ id: 'c4', severity: 'suggestion', body: 'Thanks for the clear PR.' }),
        comment({ id: 'c5', file: 'src/money/round.ts', line: 19, status: 'draft', body: 'Not accepted.' }),
        comment({ id: 'c6', file: 'src/money/round.ts', line: 19, status: 'rejected', body: 'Rejected.' }),
        comment({ id: 'c7', body: '   ' }),
      ],
      head,
    );
    assert.deepEqual(review.comments, [{ path: 'src/money/round.ts', line: 18, side: 'RIGHT', body: '**Blocking:** Keep half-up.' }]);
    assert.equal(review.body, ['` src/money/round.ts:3 `: **Question:** Why this import?', '` src/tax/vat.ts `: **Nit:** Typo.', '**Suggestion:** Thanks for the clear PR.'].join('\n\n'));
  });

  it('has an empty body when every comment is inline, and nothing at all when nothing is accepted', () => {
    assert.deepEqual(buildGithubReview([comment({ file: 'src/money/round.ts', line: 17 })], head), {
      body: '',
      comments: [{ path: 'src/money/round.ts', line: 17, side: 'RIGHT', body: '**Suggestion:** Body.' }],
    });
    assert.deepEqual(buildGithubReview([comment({ status: 'draft' })], head), { body: '', comments: [] });
  });

  it('never puts a non-integer line inline', () => {
    const review = buildGithubReview([comment({ file: 'src/money/round.ts', line: 18.5 })], new Map([['src/money/round.ts', new Set([18.5])]]));
    assert.deepEqual(review.comments, []);
  });

  it('keeps hostile paths inside their code span', () => {
    assert.equal(locationSpan({ file: 'a`b.ts', line: 2 }), '`` a`b.ts:2 ``');
    assert.equal(locationSpan({ file: 'x.ts' }), '` x.ts `');
    assert.equal(locationSpan({}), '');
    assert.equal(commentText({ severity: 'nit', body: '  tidy  ' }), '**Nit:** tidy');
  });

  it('inlines the sample’s seeded comments against the sample diff', () => {
    const lines = sampleHeadLines();
    const review = buildGithubReview(
      [
        comment({ id: 'a', file: 'src/money/round.ts', line: 18, severity: 'blocking', body: 'Keep half-up.' }),
        comment({ id: 'b', file: 'src/invoice/discount.ts', line: 23, severity: 'blocking', body: 'Add tests.' }),
        comment({ id: 'c', file: 'src/money/money.ts', line: 20, severity: 'nit', body: 'Unchanged line.' }),
      ],
      lines,
    );
    assert.deepEqual(
      review.comments.map((c) => `${c.path}:${c.line}`),
      ['src/money/round.ts:18', 'src/invoice/discount.ts:23'],
    );
    assert.equal(review.body, '` src/money/money.ts:20 `: **Nit:** Unchanged line.', 'money.ts:20 is outside both of its hunks');
  });
});

describe('parseGithubRemote', () => {
  it('reads owner and repo from https, ssh and scp-like remotes', () => {
    const want = { host: 'github.com', owner: 'acme', repo: 'ledger' };
    assert.deepEqual(parseGithubRemote('https://github.com/acme/ledger.git'), want);
    assert.deepEqual(parseGithubRemote('https://token@github.com/acme/ledger'), want);
    assert.deepEqual(parseGithubRemote('git@github.com:acme/ledger.git'), want);
    assert.deepEqual(parseGithubRemote('ssh://git@github.com/acme/ledger.git'), want);
    assert.deepEqual(parseGithubRemote('https://GitHub.com/acme/ledger/'), want);
    assert.deepEqual(parseGithubRemote('https://github.com/acme/my.repo_name-2'), { host: 'github.com', owner: 'acme', repo: 'my.repo_name-2' });
  });

  it('accepts other hosts only when asked', () => {
    assert.equal(parseGithubRemote('https://ghe.example.com/acme/ledger'), undefined);
    assert.deepEqual(parseGithubRemote('https://ghe.example.com/acme/ledger', ['ghe.example.com']), { host: 'ghe.example.com', owner: 'acme', repo: 'ledger' });
  });

  it('rejects anything that is not exactly owner/repo', () => {
    assert.equal(parseGithubRemote('https://gitlab.com/acme/ledger'), undefined);
    assert.equal(parseGithubRemote('https://github.com/acme'), undefined);
    assert.equal(parseGithubRemote('https://github.com/acme/ledger/tree/main'), undefined);
    assert.equal(parseGithubRemote('https://github.com/acme/..'), undefined);
    assert.equal(parseGithubRemote('https://github.com/ac me/ledger'), undefined);
    assert.equal(parseGithubRemote('/home/me/ledger'), undefined);
    assert.equal(parseGithubRemote(''), undefined);
  });
});

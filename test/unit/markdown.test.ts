import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { codeSpan, literal } from '../../src/host/markdown';

/** Splits a code span into its fence and the text a CommonMark renderer would show. */
function parse(span: string): { fence: string; shown: string } {
  const fence = /^`+/.exec(span)![0];
  assert.ok(span.endsWith(fence), `does not close with ${fence}: ${span}`);
  const inner = span.slice(fence.length, span.length - fence.length);
  assert.ok(!new RegExp(`(^|[^\`])${fence}([^\`]|$)`).test(inner), `the fence ${fence} also occurs inside: ${span}`);
  return { fence, shown: inner.startsWith(' ') && inner.endsWith(' ') && inner.trim() ? inner.slice(1, -1) : inner };
}

describe('codeSpan', () => {
  it('wraps a plain symbol', () => {
    assert.equal(codeSpan('Money.multiply'), '` Money.multiply `');
    assert.equal(parse(codeSpan('Money.multiply')).shown, 'Money.multiply');
  });

  it('keeps backticks inside the span instead of letting them close it', () => {
    for (const text of ['x` ![](https://attacker.example/p.png) `', '``a```b`', '`lead', 'trail`', '`']) {
      const span = codeSpan(text);
      const { fence, shown } = parse(span);
      assert.ok(fence.length > Math.max(...(text.match(/`+/g) ?? ['']).map((r) => r.length)), span);
      assert.equal(shown, text);
    }
  });

  it('stays on one line, so a blank line cannot end the span early', () => {
    const span = codeSpan('x\n\n![](https://attacker.example/p.png)\r\n');
    assert.ok(!/[\r\n]/.test(span), span);
    assert.equal(parse(span).shown, 'x ![](https://attacker.example/p.png)');
  });

  it('is empty for blank text', () => {
    assert.equal(codeSpan(''), '');
    assert.equal(codeSpan(' \n\t '), '');
  });
});

describe('literal', () => {
  /** What a CommonMark renderer shows for backslash escapes. */
  const unescape = (md: string) => md.replace(/\\([!-/:-@[-`{-~])/g, '$1');

  it('escapes every ASCII punctuation mark and nothing else', () => {
    let ascii = '';
    for (let c = 0x21; c < 0x7f; c++) ascii += String.fromCharCode(c);
    const out = literal(ascii);
    assert.equal(unescape(out), ascii);
    assert.equal(out.replace(/\\[!-/:-@[-`{-~]/g, ''), ascii.replace(/[!-/:-@[-`{-~]/g, ''), 'letters and digits stay as they are');
    assert.equal(literal('splits into proportional parts — no cent lost'), 'splits into proportional parts — no cent lost');
  });

  it('leaves no markdown, HTML or autolink syntax live', () => {
    const hostile = 'adds ![](https://a.example/g.png) [x](command:workbench.action.terminal.new) <file:///etc/passwd> <b>b</b> www.evil.example a@b.example `c`';
    const out = literal(hostile);
    assert.equal(unescape(out), hostile);
    // Every special character is preceded by a backslash, so none can start a construct.
    assert.ok(!/(^|[^\\])[!\[\]()<>`:@.]/.test(out.replace(/\\\\/g, '')), out);
  });

  it('keeps it to one line', () => {
    assert.equal(literal('a\n\n# b\r\n'), 'a \\# b');
  });
});

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { revertEdit, undoBackTo, type Undoable } from '../../src/host/strayEdits';

/** A document with an undo stack of whole-text states; `steps` are the undo elements, oldest first. */
function fakeDoc(steps: string[], opts: { aimable?: () => boolean } = {}) {
  const undone: string[] = [];
  const done = [...steps];
  const calls = { undo: 0, redo: 0 };
  const doc: Undoable & { calls: typeof calls; type(text: string): void } = {
    calls,
    text: () => done[done.length - 1],
    type(text) {
      done.push(text);
      undone.length = 0;
    },
    async undo() {
      if (opts.aimable && !opts.aimable()) return false;
      calls.undo++;
      if (done.length > 1) undone.push(done.pop()!);
      return true;
    },
    async redo() {
      if (opts.aimable && !opts.aimable()) return false;
      calls.redo++;
      if (undone.length) done.push(undone.pop()!);
      return true;
    },
  };
  return doc;
}

describe('undoBackTo', () => {
  it('undoes the stray edits, stopping as soon as the text is back', async () => {
    const doc = fakeDoc(['a', 'a\n', 'a\n ']);
    assert.equal(await undoBackTo(doc, 'a', () => 5), true);
    assert.equal(doc.text(), 'a');
    assert.equal(doc.calls.undo, 2);
    assert.equal(doc.calls.redo, 0);
  });

  it('does nothing when the text never changed', async () => {
    const doc = fakeDoc(['a']);
    assert.equal(await undoBackTo(doc, 'a', () => 3), true);
    assert.equal(doc.calls.undo, 0);
  });

  it('redoes everything when an undo step reaches past the snapshot, so earlier work survives', async () => {
    // The user typed "b" before the window and "c" during it, merged into one undo step: undoing
    // it would also drop "b", so the text never equals the snapshot "ab".
    const doc = fakeDoc(['a', 'abc']);
    assert.equal(await undoBackTo(doc, 'ab', () => 2), false);
    assert.equal(doc.text(), 'abc');
    assert.equal(doc.calls.undo, doc.calls.redo);
  });

  it('never undoes more steps than edits were seen', async () => {
    const doc = fakeDoc(['x', 'y', 'z', 'w']);
    assert.equal(await undoBackTo(doc, 'x', () => 2), false);
    assert.equal(doc.calls.undo, 2);
    assert.equal(doc.text(), 'w');
  });

  it('counts edits that arrive while it is undoing', async () => {
    let seen = 1;
    const doc = fakeDoc(['a', 'a\n']);
    const realUndo = doc.undo.bind(doc);
    let typed = false;
    doc.undo = async () => {
      if (!typed) {
        // A second key lands just before the first undo runs.
        doc.type('a\n ');
        seen++;
        typed = true;
      }
      return realUndo();
    };
    assert.equal(await undoBackTo(doc, 'a', () => seen), true);
    assert.equal(doc.text(), 'a');
  });

  it('stops when undo can no longer be aimed at the document', async () => {
    let aimable = true;
    const doc = fakeDoc(['a', 'ab', 'abc'], { aimable: () => aimable });
    const realUndo = doc.undo.bind(doc);
    doc.undo = async () => {
      const ok = await realUndo();
      aimable = false; // focus moved after the first step
      return ok;
    };
    assert.equal(await undoBackTo(doc, 'a', () => 5), false);
    assert.equal(doc.calls.undo, 1);
    assert.equal(doc.calls.redo, 0, 'a redo could land in whatever editor has focus now');
  });
});

describe('revertEdit', () => {
  const apply = (now: string, e: { start: number; end: number; text: string }) => now.slice(0, e.start) + e.text + now.slice(e.end);

  it('replaces only the part that differs', () => {
    const before = 'export function f() {\n  return 1;\n}\n';
    const now = 'export function f() {\n\n    return 1;\n}\n';
    const e = revertEdit(now, before);
    assert.equal(apply(now, e), before);
    assert.ok(e.end - e.start <= 5, `replaced ${JSON.stringify(now.slice(e.start, e.end))}`);
  });

  it('handles insertions, deletions and identical text', () => {
    for (const [now, before] of [
      ['abc', 'abc'],
      ['ab\ncd', 'abcd'],
      ['abcd', 'ab\ncd'],
      ['', 'x'],
      ['x', ''],
      ['aaaa', 'aa'],
      ['line\r\n\r\nnext\r\n', 'line\r\nnext\r\n'],
    ]) {
      assert.equal(apply(now, revertEdit(now, before)), before, `${JSON.stringify(now)} -> ${JSON.stringify(before)}`);
    }
    assert.deepEqual(revertEdit('abc', 'abc'), { start: 3, end: 3, text: '' });
  });
});

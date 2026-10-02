import { test } from 'node:test';
import assert from 'node:assert/strict';
import { roundToCents } from '../src/money/round';

test('whole cents are unchanged', () => {
  assert.equal(roundToCents(1999), 1999);
  assert.equal(roundToCents(0), 0);
});

test('fractions below a half round down, above a half round up', () => {
  assert.equal(roundToCents(12.4), 12);
  assert.equal(roundToCents(12.6), 13);
});

test('halves round away from zero', () => {
  assert.equal(roundToCents(12.5), 13); // EUR 0.125 -> EUR 0.13
  assert.equal(roundToCents(13.5), 14);
  assert.equal(roundToCents(-12.5), -13);
});

test('float noise does not hide a half', () => {
  assert.equal(roundToCents(1.005 * 100), 101);
});

test('rejects non-finite amounts', () => {
  assert.throws(() => roundToCents(Number.NaN), RangeError);
  assert.throws(() => roundToCents(Infinity), RangeError);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Money } from '../src/money/money';
import { computeVat, isCountry, vatRate } from '../src/tax/vat';

test('standard rates per country', () => {
  assert.equal(vatRate('DE'), 0.19);
  assert.equal(vatRate('FR'), 0.2);
  assert.equal(vatRate('NL'), 0.21);
});

test('reduced rates per country', () => {
  assert.equal(vatRate('DE', 'reduced'), 0.07);
  assert.equal(vatRate('FR', 'reduced'), 0.055);
});

test('e-books get the reduced rate where the country opted in', () => {
  assert.equal(vatRate('DE', 'ebook'), 0.07);
  assert.equal(vatRate('FR', 'ebook'), 0.055);
});

test('e-books fall back to the standard rate elsewhere', () => {
  assert.equal(vatRate('GB', 'ebook'), 0.2);
});

test('computeVat rounds to whole cents', () => {
  assert.equal(computeVat(Money.of(1999, 'EUR'), 'DE').cents, 380); // 19.99 * 19% = 3.7981
});

test('isCountry accepts known countries only', () => {
  assert.equal(isCountry('NL'), true);
  assert.equal(isCountry('toString'), false);
});

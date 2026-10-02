import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createInvoiceHandler } from '../src/api/handlers';

const order = {
  currency: 'EUR',
  country: 'DE',
  lines: [{ description: 'Desk lamp', unitPriceCents: 4999, quantity: 2 }],
};

test('returns 201 with the totals as JSON', () => {
  const res = createInvoiceHandler({ body: order });
  assert.equal(res.status, 201);
  assert.deepEqual(JSON.parse(JSON.stringify(res.body)), {
    net: { amount: '99.98', currency: 'EUR' },
    discount: { amount: '0.00', currency: 'EUR' },
    vat: { amount: '19.00', currency: 'EUR' },
    gross: { amount: '118.98', currency: 'EUR' },
  });
});

test('rejects an unknown country', () => {
  assert.equal(createInvoiceHandler({ body: { ...order, country: 'XX' } }).status, 400);
});

test('rejects an unknown VAT category', () => {
  const lines = [{ ...order.lines[0], vatCategory: 'luxury' }];
  assert.equal(createInvoiceHandler({ body: { ...order, lines } }).status, 400);
});

test('rejects an unknown discount code', () => {
  assert.equal(createInvoiceHandler({ body: { ...order, discountCode: 'NOPE' } }).status, 400);
});

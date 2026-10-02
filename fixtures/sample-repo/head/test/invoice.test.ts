import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Invoice } from '../src/invoice/invoice';
import { Money } from '../src/money/money';

const eur = (cents: number) => Money.of(cents, 'EUR');

test('totals a single line', () => {
  const { net, vat, gross } = new Invoice('EUR', 'DE')
    .addLine({ description: 'Chair', unitPrice: eur(1000), quantity: 3 })
    .total();
  assert.equal(net.cents, 3000);
  assert.equal(vat.cents, 570);
  assert.equal(gross.cents, 3570);
});

test('applies the reduced rate per line', () => {
  const invoice = new Invoice('EUR', 'FR')
    .addLine({ description: 'Cookbook', unitPrice: eur(2000), quantity: 1, vatCategory: 'reduced' })
    .addLine({ description: 'Notebook', unitPrice: eur(500), quantity: 2 });
  assert.equal(invoice.total().vat.cents, 310); // 2000 * 5.5% + 1000 * 20%
});

test('rejects a line in another currency', () => {
  const invoice = new Invoice('EUR', 'DE');
  const tea = { description: 'Tea', unitPrice: Money.of(300, 'GBP'), quantity: 1 };
  assert.throws(() => invoice.addLine(tea), TypeError);
});

test('rejects fractional quantities', () => {
  const invoice = new Invoice('EUR', 'DE');
  assert.throws(() => invoice.addLine({ description: 'Tea', unitPrice: eur(300), quantity: 1.5 }), RangeError);
});

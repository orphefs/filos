import { Money } from '../money/money';
import type { Invoice } from './invoice';

/** A promotion code: a percentage off the net subtotal, or a fixed amount off it. */
export type DiscountCode =
  | { code: string; kind: 'percentage'; percent: number }
  | { code: string; kind: 'fixed'; cents: number };

// Live promotions. They change rarely enough that shipping a release is fine.
const ACTIVE_CODES: readonly DiscountCode[] = [
  { code: 'WELCOME10', kind: 'percentage', percent: 10 },
  { code: 'SPRING25', kind: 'percentage', percent: 25 },
  { code: 'FIVEOFF', kind: 'fixed', cents: 500 },
];

/** Looks up a code as a customer typed it: case and surrounding spaces don't matter. */
export function findDiscount(code: string): DiscountCode | undefined {
  const normalised = code.trim().toUpperCase();
  return ACTIVE_CODES.find((d) => d.code === normalised);
}

/** How much a code takes off the invoice's net subtotal. Never more than the subtotal. */
export function applyDiscount(invoice: Invoice, discount: DiscountCode): Money {
  const subtotal = invoice.subtotal();
  const off =
    discount.kind === 'percentage'
      ? subtotal.multiply(discount.percent / 100)
      : Money.of(discount.cents, invoice.currency);
  return off.cents > subtotal.cents ? subtotal : off;
}

import { roundToCents } from '../money/round';

export interface LineItem {
  price: number;
  qty: number;
}

/** Order total including tax, rounded once at the end. */
export function orderTotal(items: LineItem[], taxRate: number): number {
  const subtotal = items.reduce((sum, item) => sum + item.price * item.qty, 0);
  return roundToCents(subtotal * (1 + taxRate));
}

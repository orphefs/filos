import { Money, type Currency } from '../money/money';
import { computeVat, type Country, type VatCategory } from '../tax/vat';
import { applyDiscount, type DiscountCode } from './discount';

export interface InvoiceLine {
  description: string;
  unitPrice: Money;
  quantity: number;
  vatCategory?: VatCategory;
}

export interface InvoiceTotals {
  net: Money;
  discount: Money;
  vat: Money;
  gross: Money;
}

export class Invoice {
  private readonly lines: InvoiceLine[] = [];

  constructor(
    readonly currency: Currency,
    readonly country: Country,
  ) {}

  addLine(line: InvoiceLine): this {
    if (line.unitPrice.currency !== this.currency) {
      throw new TypeError(`line "${line.description}" is in ${line.unitPrice.currency}, invoice is ${this.currency}`);
    }
    if (!Number.isInteger(line.quantity) || line.quantity <= 0) {
      throw new RangeError(`line "${line.description}" needs a positive whole quantity`);
    }
    this.lines.push(line);
    return this;
  }

  /** Sum of line nets (unit price x quantity). */
  subtotal(): Money {
    return this.lines.reduce((sum, line) => sum.add(line.unitPrice.multiply(line.quantity)), Money.zero(this.currency));
  }

  /**
   * Net (after discount), discount, VAT and gross. VAT is rounded once per rate on the
   * whole invoice instead of per line, so per-line rounding can't add up. The discount
   * is spread across rates in proportion to their net.
   */
  total(discountCode?: DiscountCode): InvoiceTotals {
    const groups = [...this.netByCategory()];
    const discount = discountCode ? applyDiscount(this, discountCode) : Money.zero(this.currency);
    const shares =
      discount.cents > 0
        ? discount.allocate(groups.map(([, groupNet]) => groupNet.cents))
        : groups.map(() => Money.zero(this.currency));

    let net = Money.zero(this.currency);
    let vat = Money.zero(this.currency);
    groups.forEach(([category, groupNet], i) => {
      const discounted = groupNet.subtract(shares[i]);
      net = net.add(discounted);
      vat = vat.add(computeVat(discounted, this.country, category));
    });
    return { net, discount, vat, gross: net.add(vat) };
  }

  private netByCategory(): Map<VatCategory, Money> {
    const groups = new Map<VatCategory, Money>();
    for (const line of this.lines) {
      const category = line.vatCategory ?? 'standard';
      const lineNet = line.unitPrice.multiply(line.quantity);
      groups.set(category, (groups.get(category) ?? Money.zero(this.currency)).add(lineNet));
    }
    return groups;
  }
}

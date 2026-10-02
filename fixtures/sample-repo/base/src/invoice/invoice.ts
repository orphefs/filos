import { Money, type Currency } from '../money/money';
import { computeVat, type Country, type VatCategory } from '../tax/vat';

export interface InvoiceLine {
  description: string;
  unitPrice: Money;
  quantity: number;
  vatCategory?: VatCategory;
}

export interface InvoiceTotals {
  net: Money;
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

  /** Net, VAT and gross. VAT is rounded on each line, then summed. */
  total(): InvoiceTotals {
    let vat = Money.zero(this.currency);
    for (const line of this.lines) {
      const lineNet = line.unitPrice.multiply(line.quantity);
      vat = vat.add(computeVat(lineNet, this.country, line.vatCategory));
    }
    const net = this.subtotal();
    return { net, vat, gross: net.add(vat) };
  }
}

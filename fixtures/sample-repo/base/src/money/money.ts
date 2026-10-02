import { roundToCents } from './round';

export type Currency = 'EUR' | 'GBP' | 'USD';

export function isCurrency(value: unknown): value is Currency {
  return value === 'EUR' || value === 'GBP' || value === 'USD';
}

/** An immutable amount of money: integer cents plus a currency. */
export class Money {
  private constructor(
    readonly cents: number,
    readonly currency: Currency,
  ) {}

  static of(cents: number, currency: Currency): Money {
    if (!Number.isInteger(cents)) throw new RangeError(`Money needs whole cents, got ${cents}`);
    return new Money(cents, currency);
  }

  static zero(currency: Currency): Money {
    return new Money(0, currency);
  }

  add(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.cents + other.cents, this.currency);
  }

  subtract(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.cents - other.cents, this.currency);
  }

  /** Scales by a factor (quantity, tax rate, discount) and rounds to whole cents. */
  multiply(factor: number): Money {
    return new Money(roundToCents(this.cents * factor), this.currency);
  }

  /**
   * Splits into parts proportional to `ratios` without losing a cent:
   * leftover cents go to the first parts, one each.
   */
  allocate(ratios: number[]): Money[] {
    const total = ratios.reduce((sum, r) => sum + r, 0);
    if (total <= 0) throw new RangeError('allocate needs a positive total ratio');
    const parts = ratios.map((r) => Math.floor((this.cents * r) / total));
    let leftover = this.cents - parts.reduce((sum, p) => sum + p, 0);
    for (let i = 0; leftover > 0; i++, leftover--) parts[i] += 1;
    return parts.map((p) => new Money(p, this.currency));
  }

  toJSON(): { amount: string; currency: Currency } {
    return { amount: (this.cents / 100).toFixed(2), currency: this.currency };
  }

  private assertSameCurrency(other: Money): void {
    if (other.currency !== this.currency) {
      throw new TypeError(`currency mismatch: ${this.currency} vs ${other.currency}`);
    }
  }
}

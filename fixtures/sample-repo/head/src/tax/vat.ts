import type { Money } from '../money/money';

export type Country = 'DE' | 'FR' | 'GB' | 'NL';

export const VAT_CATEGORIES = ['standard', 'reduced', 'ebook'] as const;
export type VatCategory = (typeof VAT_CATEGORIES)[number];

// Rates as fractions. Which goods count as "reduced" is decided by the caller.
const RATES: Record<Country, { standard: number; reduced: number }> = {
  DE: { standard: 0.19, reduced: 0.07 },
  FR: { standard: 0.2, reduced: 0.055 },
  GB: { standard: 0.2, reduced: 0.05 },
  NL: { standard: 0.21, reduced: 0.09 },
};

// Countries may tax e-books like printed books, but each one opts in.
// Countries missing here charge their standard rate on e-books.
const EBOOK_RATES: Partial<Record<Country, number>> = { DE: 0.07, FR: 0.055 };

export function isCountry(value: unknown): value is Country {
  return typeof value === 'string' && Object.hasOwn(RATES, value);
}

export function isVatCategory(value: unknown): value is VatCategory {
  return VAT_CATEGORIES.includes(value as VatCategory);
}

export function vatRate(country: Country, category: VatCategory = 'standard'): number {
  if (category === 'ebook') return EBOOK_RATES[country] ?? RATES[country].standard;
  return RATES[country][category];
}

/** VAT owed on a net amount, rounded to whole cents. */
export function computeVat(net: Money, country: Country, category: VatCategory = 'standard'): Money {
  return net.multiply(vatRate(country, category));
}

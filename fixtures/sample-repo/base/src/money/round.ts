// Rounding for monetary amounts. Money is held as integer cents; this is the one
// place where fractional cents (from multiplying by a rate or factor) become whole ones.

// Absorbs float noise such as 1.005 * 100 = 100.49999999999999.
const EPSILON = 1e-9;

/**
 * Rounds an amount in cents (possibly fractional) to whole cents.
 * Ties round away from zero: 12.5 -> 13, -12.5 -> -13.
 */
export function roundToCents(cents: number): number {
  if (!Number.isFinite(cents)) {
    throw new RangeError(`cannot round a non-finite amount: ${cents}`);
  }
  const sign = cents < 0 ? -1 : 1;
  return sign * Math.floor(Math.abs(cents) + 0.5 + EPSILON);
}

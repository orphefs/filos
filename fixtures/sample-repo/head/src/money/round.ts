// Rounding for monetary amounts. Money is held as integer cents; this is the one
// place where fractional cents (from multiplying by a rate or factor) become whole ones.

/**
 * half-up:   ties round away from zero (12.5 -> 13). The only behaviour before this change.
 * half-even: ties round to the even neighbour (12.5 -> 12, 13.5 -> 14), so rounding
 *            errors cancel out across many amounts instead of always adding up.
 */
export type RoundingMode = 'half-up' | 'half-even';

// Absorbs float noise such as 1.005 * 100 = 100.49999999999999.
const EPSILON = 1e-9;

/**
 * Rounds an amount in cents (possibly fractional) to whole cents.
 * Defaults to half-even (banker's rounding); pass 'half-up' for the old behaviour.
 */
export function roundToCents(cents: number, mode: RoundingMode = 'half-even'): number {
  if (!Number.isFinite(cents)) {
    throw new RangeError(`cannot round a non-finite amount: ${cents}`);
  }
  const sign = cents < 0 ? -1 : 1;
  const abs = Math.abs(cents);
  const floor = Math.floor(abs);
  const isTie = Math.abs(abs - floor - 0.5) < EPSILON;

  if (!isTie) return sign * Math.floor(abs + 0.5);
  if (mode === 'half-up') return sign * (floor + 1);
  return sign * (floor % 2 === 0 ? floor : floor + 1);
}

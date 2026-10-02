// Rounding helpers shared by every price calculation.

/**
 * Rounds an amount to whole cents. Ties go to the even cent (banker's rounding),
 * so summing many rounded prices doesn't drift upwards.
 */
export function roundToCents(amount: number): number {
  const cents = amount * 100;
  const floor = Math.floor(cents);
  if (Math.abs(cents - floor - 0.5) < 1e-9) {
    return (floor % 2 === 0 ? floor : floor + 1) / 100;
  }
  return Math.round(cents) / 100;
}

/** Formats an amount as a fixed two-decimal string, e.g. "12.30". */
export function formatCents(amount: number): string {
  return roundToCents(amount).toFixed(2);
}

/**
 * Money helpers. Amounts are integer cents; percentages are integer basis
 * points (100 bps = 1%). This is the ONLY place money is divided or rounded
 * (docs/decisions-detailed.md D3, D9): half-up to the whole cent, in exact integer
 * arithmetic, so the browser and the service always agree.
 */

export type Cents = number;

const BPS_PER_WHOLE = 10_000;

function assertAmount(name: string, value: number, min: number): void {
  if (!Number.isSafeInteger(value) || value < min) {
    throw new RangeError(`${name} must be an integer >= ${min}, got ${value}`);
  }
}

/** round-half-up(numerator / denominator) for non-negative integers, exactly. */
export function roundDiv(numerator: number, denominator: number): number {
  assertAmount('numerator', numerator, 0);
  assertAmount('denominator', denominator, 1);
  const n = BigInt(numerator);
  const d = BigInt(denominator);
  // floor((2n + d) / 2d) == round-half-up(n / d) for n >= 0; BigInt division truncates, which is floor here.
  return Number((2n * n + d) / (2n * d));
}

/** round-half-up(cents * bps / 10000), without an intermediate that can lose precision. */
export function bpsOf(cents: Cents, bps: number): Cents {
  assertAmount('cents', cents, 0);
  assertAmount('bps', bps, 0);
  const product = BigInt(cents) * BigInt(bps);
  const d = BigInt(BPS_PER_WHOLE);
  return Number((2n * product + d) / (2n * d));
}

/** 1234 -> "$12.34". Display only; never parse this back into an amount. */
export function formatCents(cents: Cents): string {
  assertAmount('cents', Math.abs(cents), 0);
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  return `${sign}$${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}

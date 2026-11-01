import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { bpsOf, formatCents, roundDiv } from '../../src/core/money.js';

describe('roundDiv: half-up to the whole unit', () => {
  it.each([
    [0, 1, 0],
    [1, 2, 1], // exactly .5 rounds UP
    [3, 2, 2], // 1.5 -> 2
    [5, 10, 1], // 0.5 -> 1
    [4, 10, 0], // 0.4 -> 0
    [6, 10, 1], // 0.6 -> 1
    [775, 10, 78], // 77.5 -> 78
    [774, 10, 77], // 77.4 -> 77
    [10, 3, 3], // 3.33 -> 3
    [11, 3, 4], // 3.67 -> 4
  ])('roundDiv(%i, %i) = %i', (n, d, expected) => {
    expect(roundDiv(n, d)).toBe(expected);
  });

  it('matches a reference implementation on random inputs', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 1_000_000_000 }), fc.integer({ min: 1, max: 100_000 }), (n, d) => {
        // Exact for these magnitudes: integer operands, one correctly-rounded division, then floor.
        expect(roundDiv(n, d)).toBe(Math.floor((2 * n + d) / (2 * d)));
      }),
    );
  });

  it('is within half a unit of the true quotient', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 1_000_000 }), fc.integer({ min: 1, max: 10_000 }), (n, d) => {
        // |result - n/d| <= 1/2  <=>  |2*d*result - 2*n| <= d, all in integers.
        const r = roundDiv(n, d);
        expect(Math.abs(2 * d * r - 2 * n)).toBeLessThanOrEqual(d);
      }),
    );
  });

  it('rejects non-integers, negatives and a zero denominator rather than guessing', () => {
    expect(() => roundDiv(1.5, 2)).toThrow(RangeError);
    expect(() => roundDiv(-1, 2)).toThrow(RangeError);
    expect(() => roundDiv(1, 0)).toThrow(RangeError);
    expect(() => roundDiv(Number.NaN, 1)).toThrow(RangeError);
  });
});

describe('bpsOf: a percentage of an amount, in basis points', () => {
  it('prices the standard toppings from the brief (8% basic, 11% premium)', () => {
    expect(bpsOf(500, 800)).toBe(40);
    expect(bpsOf(700, 800)).toBe(56);
    expect(bpsOf(1200, 800)).toBe(96);
    expect(bpsOf(500, 1100)).toBe(55);
    expect(bpsOf(700, 1100)).toBe(77);
    expect(bpsOf(1200, 1100)).toBe(132);
  });

  it('rounds half-up at the boundary', () => {
    expect(bpsOf(50, 1100)).toBe(6); // 5.5 -> 6
    expect(bpsOf(45, 1100)).toBe(5); // 4.95 -> 5
    expect(bpsOf(9, 500)).toBe(0); // 0.45 -> 0
    expect(bpsOf(10, 500)).toBe(1); // 0.5 -> 1
  });

  it('0% and 100% are exact', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 10_000_000 }), (c) => {
        expect(bpsOf(c, 0)).toBe(0);
        expect(bpsOf(c, 10_000)).toBe(c);
      }),
    );
  });

  it('never exceeds the amount for rates up to 100%', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 10_000_000 }), fc.integer({ min: 0, max: 10_000 }), (c, bps) => {
        expect(bpsOf(c, bps)).toBeLessThanOrEqual(c);
      }),
    );
  });
});

describe('formatCents', () => {
  it.each([
    [0, '$0.00'],
    [5, '$0.05'],
    [40, '$0.40'],
    [1200, '$12.00'],
    [123456, '$1234.56'],
    [-500, '-$5.00'],
  ])('%i -> %s', (cents, text) => {
    expect(formatCents(cents)).toBe(text);
  });
});

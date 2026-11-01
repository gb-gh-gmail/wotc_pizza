import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { LIMITS, type TipInput } from '../../src/core/order.js';
import { checkTip, computeTotals, inconsistencies, needsTipConfirmation, type Checkable } from '../../src/core/totals.js';

// Stage 3 on its own: from a subtotal and a discount to tax, tip and total, and the final check.

const totals = (subtotalCents: number, discountCents = 0, taxRateBps = 650, tip: TipInput = { mode: 'none' }) =>
  computeTotals({ subtotalCents, discountCents, taxRateBps, tip });

describe('tax: charged on the discounted amount, rounded half-up', () => {
  it.each([
    // subtotal, discount, tax rate (bps), expected taxable, expected tax
    [500, 0, 650, 500, 33], // 32.5   -> 33 (half rounds up)
    [1666, 0, 650, 1666, 108], // 108.29 -> 108
    [1428, 143, 650, 1285, 84], // 83.525 -> 84
    [2500, 500, 650, 2000, 130], // exact
    [1200, 0, 650, 1200, 78], // exact
    [100, 0, 650, 100, 7], // 6.5   -> 7
    [10, 0, 650, 10, 1], // 0.65  -> 1
    [7, 0, 650, 7, 0], // 0.455 -> 0
    [500, 0, 0, 500, 0], // no tax
    [500, 500, 650, 0, 0], // a fully discounted order owes no tax
    [0, 0, 650, 0, 0],
  ])('subtotal %i - discount %i at %i bps: taxable %i, tax %i', (subtotal, discount, rate, taxable, tax) => {
    expect(totals(subtotal, discount, rate)).toMatchObject({ taxableCents: taxable, taxCents: tax });
  });

  it('tax is taken after the discount, not before', () => {
    expect(totals(2500, 500).taxCents).toBe(130); // 6.5% of 2000, not of 2500 (= 163)
  });
});

describe('tip', () => {
  it('none adds nothing', () => {
    expect(totals(500)).toEqual({ taxableCents: 500, taxCents: 33, tipCents: 0, totalCents: 533 });
  });

  it('a dollar tip is added as entered, whatever the order costs', () => {
    expect(totals(500, 0, 650, { mode: 'amount', cents: 500 })).toMatchObject({ tipCents: 500, totalCents: 1033 });
    expect(totals(0, 0, 650, { mode: 'amount', cents: 250 })).toMatchObject({ tipCents: 250, totalCents: 250 });
  });

  it('a percentage tip is of the total bill: discounted amount plus tax', () => {
    // 1285 + 84 = 1369 ; 20% = 273.8 -> 274
    expect(totals(1428, 143, 650, { mode: 'percent', bps: 2000 })).toMatchObject({ tipCents: 274, totalCents: 1369 + 274 });
  });

  it.each([
    [1500, 80], // 533 * 15% = 79.95 -> 80
    [1000, 53], // 53.3 -> 53
    [100, 5], // 5.33 -> 5
    [0, 0],
    [10_000, 533], // 100%
  ])('a %i bps tip on a $5.33 bill is %i cents (half-up)', (bps, expected) => {
    expect(totals(500, 0, 650, { mode: 'percent', bps }).tipCents).toBe(expected);
  });

  it('rounds exactly .5 up', () => {
    // bill = 100 + 7 = 107 ; 50% = 53.5 -> 54
    expect(totals(100, 0, 650, { mode: 'percent', bps: 5000 }).tipCents).toBe(54);
  });
});

describe('checkTip', () => {
  it.each<[string, unknown]>([
    ['none', { mode: 'none' }],
    ['$0', { mode: 'amount', cents: 0 }],
    ['the dollar limit', { mode: 'amount', cents: LIMITS.maxTipCents }],
    ['0%', { mode: 'percent', bps: 0 }],
    ['the percent limit', { mode: 'percent', bps: LIMITS.maxTipBps }],
  ])('accepts %s', (_label, tip) => {
    expect(checkTip(tip)).toBeNull();
  });

  it.each<[string, unknown, RegExp]>([
    ['negative dollars', { mode: 'amount', cents: -1 }, /\$0\.00 or more/],
    ['fractional cents', { mode: 'amount', cents: 10.5 }, /\$0\.00 or more/],
    ['dollars as text', { mode: 'amount', cents: '5' }, /\$0\.00 or more/],
    ['missing dollars', { mode: 'amount' }, /\$0\.00 or more/],
    ['over the dollar limit', { mode: 'amount', cents: LIMITS.maxTipCents + 1 }, /more than \$500\.00/],
    ['negative percent', { mode: 'percent', bps: -1 }, /0% or more/],
    ['NaN percent', { mode: 'percent', bps: Number.NaN }, /0% or more/],
    ['over the percent limit', { mode: 'percent', bps: LIMITS.maxTipBps + 1 }, /more than 100%/],
    ['an unknown mode', { mode: 'free-pizza' }, /Choose no tip/],
    ['no tip object at all', undefined, /Choose no tip/],
    ['a tip that is not an object', 5, /Choose no tip/],
  ])('refuses %s with a clear message', (_label, tip, message) => {
    const issue = checkTip(tip);
    expect(issue).toMatchObject({ code: 'invalid_tip', path: 'tip' });
    expect(issue!.message).toMatch(message);
  });
});

describe('needsTipConfirmation: a very large tip must be confirmed', () => {
  // bill = discounted subtotal + tax (the "total bill"); a tip of half the bill or more is held,
  // unless the bill is under $40.00.
  it.each([
    // bill, tip, needs confirming?
    [4000, 2000, true], // exactly 50% of a $40.00 bill
    [4000, 1999, false], // a cent under 50%
    [4000, 2001, true],
    [4000, 4000, true], // 100%
    [10_000, 5000, true], // exactly 50% of $100
    [10_000, 4999, false],
    [10_000, 20_000, true], // twice the bill
    [10_000, 1800, false], // an ordinary 18% tip
    [10_000, 0, false], // no tip
    [4001, 2001, true], // 2001/4001 > 50%
    [4001, 2000, false], // 2000/4001 < 50%
  ])('bill %i, tip %i -> %s', (bill, tip, expected) => {
    expect(needsTipConfirmation(bill, tip)).toBe(expected);
  });

  it('a bill under $40.00 never needs confirming, however big the share', () => {
    expect(needsTipConfirmation(3999, 3999)).toBe(false); // $39.99 bill, tip of 100%
    expect(needsTipConfirmation(3999, 50_000)).toBe(false); // even a $500 tip
    expect(needsTipConfirmation(500, 500)).toBe(false); // a $5 bill with a $5 tip
  });

  it('the $40.00 line itself is NOT exempt (the exemption is strictly under $40)', () => {
    expect(needsTipConfirmation(4000, 2000)).toBe(true);
    expect(needsTipConfirmation(3999, 2000)).toBe(false);
  });

  it('is exact: there is no rounding at the edge, even for awkward bills', () => {
    // 50% of 4333 is 2166.5: 2166 is under, 2167 is over.
    expect(needsTipConfirmation(4333, 2166)).toBe(false);
    expect(needsTipConfirmation(4333, 2167)).toBe(true);
  });

  it('holds for every tip and bill: confirmation implies >= half the bill and a bill of $40 or more', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 5_000_000 }), fc.integer({ min: 0, max: LIMITS.maxTipCents }), (bill, tip) => {
        if (needsTipConfirmation(bill, tip)) {
          expect(bill).toBeGreaterThanOrEqual(4000);
          expect(tip * 2).toBeGreaterThanOrEqual(bill);
          expect(tip).toBeGreaterThan(0);
        } else {
          expect(bill < 4000 || tip === 0 || tip * 2 < bill).toBe(true);
        }
      }),
    );
  });
});

describe('a tip can never be negative', () => {
  it.each([-1, -500, -0.01, Number.NEGATIVE_INFINITY])('a dollar tip of %s is refused', (cents) => {
    expect(checkTip({ mode: 'amount', cents })).toMatchObject({ code: 'invalid_tip' });
  });
  it.each([-1, -1800, Number.NEGATIVE_INFINITY])('a percentage tip of %s bps is refused', (bps) => {
    expect(checkTip({ mode: 'percent', bps })).toMatchObject({ code: 'invalid_tip' });
  });
  it('and the computed tip is never negative for any valid tip', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 5_000_000 }),
        fc.oneof(
          fc.record({ mode: fc.constant('amount' as const), cents: fc.integer({ min: 0, max: LIMITS.maxTipCents }) }),
          fc.record({ mode: fc.constant('percent' as const), bps: fc.integer({ min: 0, max: LIMITS.maxTipBps }) }),
        ),
        (subtotalCents, tip) => {
          expect(computeTotals({ subtotalCents, discountCents: 0, taxRateBps: 650, tip }).tipCents).toBeGreaterThanOrEqual(0);
        },
      ),
    );
  });
});

describe('inconsistencies: the last check before an amount goes out', () => {
  const good = (): Checkable => ({
    lines: [{ unitCents: 600, quantity: 2, lineTotalCents: 1200 }, { unitCents: 300, quantity: 1, lineTotalCents: 300 }],
    subtotalCents: 1500,
    discountCents: 150,
    taxableCents: 1350,
    taxCents: 88,
    tip: { cents: 100 },
    totalCents: 1538, // 1350 + 88 + 100
  });

  it('is quiet about a breakdown that adds up', () => {
    expect(inconsistencies(good())).toEqual([]);
  });

  it.each<[string, (b: Checkable) => void, RegExp]>([
    ['a line total that is not unit x quantity', (b) => (b.lines[0]!.lineTotalCents = 1199), /line 0 total/],
    ['a subtotal that is not the sum of the lines', (b) => (b.subtotalCents = 1501), /sum of the lines/],
    ['a discount larger than the subtotal', (b) => (b.discountCents = 1600), /more than the subtotal/],
    ['a taxable amount that is not subtotal minus discount', (b) => (b.taxableCents = 1351), /taxable amount/],
    ['a total that is not taxable + tax + tip', (b) => (b.totalCents = 1539), /total is not/],
    ['a negative total', (b) => (b.totalCents = -1), /total is not a whole, non-negative/],
    ['a fractional tax', (b) => (b.taxCents = 88.5), /tax is not a whole/],
    ['a NaN tip', (b) => (b.tip.cents = Number.NaN), /tip is not a whole/],
    ['an infinite discount', (b) => (b.discountCents = Infinity), /discount is not a whole/],
  ])('catches %s', (_label, breakIt, message) => {
    const b = good();
    breakIt(b);
    expect(inconsistencies(b).join('|')).toMatch(message);
  });

  it('reports every fault, not only the first', () => {
    const b = good();
    b.subtotalCents = 1;
    b.totalCents = 2;
    expect(inconsistencies(b).length).toBeGreaterThan(1);
  });
});

describe('properties', () => {
  const inputs = fc
    .record({
      subtotalCents: fc.integer({ min: 0, max: 5_000_000 }),
      taxRateBps: fc.integer({ min: 0, max: 3000 }),
      tip: fc.oneof(
        fc.constant<TipInput>({ mode: 'none' }),
        fc.record({ mode: fc.constant('amount' as const), cents: fc.integer({ min: 0, max: LIMITS.maxTipCents }) }),
        fc.record({ mode: fc.constant('percent' as const), bps: fc.integer({ min: 0, max: LIMITS.maxTipBps }) }),
      ),
      discountShare: fc.double({ min: 0, max: 1, noNaN: true }),
    })
    .map((i) => ({ ...i, discountCents: Math.floor(i.subtotalCents * i.discountShare) }));

  it('whatever the inputs, the result always passes the final check', () => {
    fc.assert(
      fc.property(inputs, (i) => {
        const t = computeTotals(i);
        const b: Checkable = {
          lines: [{ unitCents: i.subtotalCents, quantity: 1, lineTotalCents: i.subtotalCents }],
          subtotalCents: i.subtotalCents,
          discountCents: i.discountCents,
          taxableCents: t.taxableCents,
          taxCents: t.taxCents,
          tip: { cents: t.tipCents },
          totalCents: t.totalCents,
        };
        expect(inconsistencies(b)).toEqual([]);
      }),
    );
  });

  it('a bigger discount never raises the total, and a bigger tip never lowers it', () => {
    fc.assert(
      fc.property(inputs, fc.integer({ min: 0, max: 5000 }), (i, extra) => {
        const base = computeTotals(i);
        const moreOff = computeTotals({ ...i, discountCents: Math.min(i.subtotalCents, i.discountCents + extra) });
        expect(moreOff.totalCents - moreOff.tipCents).toBeLessThanOrEqual(base.totalCents - base.tipCents);
      }),
    );
  });
});

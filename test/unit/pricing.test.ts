import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PROMO_KINDS,
  LIMITS,
  priceOrder,
  type Breakdown,
  type OrderInput,
  type PromoDef,
} from '../../src/core/pricing.js';
import { briefMenu, briefPromos, customMenu } from '../helpers/menu.js';

/** Price an order that must be valid and return its breakdown. */
function price(order: OrderInput, menu = briefMenu(), promos: readonly PromoDef[] = briefPromos): Breakdown {
  const result = priceOrder(order, menu, promos);
  if (!result.ok) throw new Error(`expected a valid order, got: ${result.issues.map((i) => i.message).join('; ')}`);
  return result.breakdown;
}
const line = (size: string, quantity = 1, toppings: string[] = []) => ({ size, quantity, toppings });
const issuesOf = (order: OrderInput) => {
  const result = priceOrder(order, briefMenu(), briefPromos);
  if (result.ok) throw new Error('expected issues');
  return result.issues;
};

// All expected values below are worked out by hand from the brief's rules.

describe('pizza and topping pricing (from the brief)', () => {
  it.each([
    ['small', 500],
    ['medium', 700],
    ['large', 1200],
  ])('a plain %s pizza is %i cents', (size, cents) => {
    expect(price({ lines: [line(size)] }).subtotalCents).toBe(cents);
  });

  it('prices toppings as a percentage of the pizza: basic 8%, premium 11%', () => {
    // small $5.00: pepperoni 8% = 0.40, bacon 11% = 0.55
    expect(price({ lines: [line('small', 1, ['pepperoni'])] }).subtotalCents).toBe(540);
    expect(price({ lines: [line('small', 1, ['bacon'])] }).subtotalCents).toBe(555);
    // large $12.00: pepperoni 0.96, bacon 1.32
    expect(price({ lines: [line('large', 1, ['pepperoni', 'bacon'])] }).subtotalCents).toBe(1200 + 96 + 132);
  });

  it('toppings cost more on bigger pizzas', () => {
    const cost = (size: string) => price({ lines: [line(size, 1, ['bacon'])] }).lines[0]!.toppings[0]!.priceCents;
    expect([cost('small'), cost('medium'), cost('large')]).toEqual([55, 77, 132]);
  });

  it('multiplies a pizza, with its toppings, by its quantity', () => {
    const b = price({ lines: [line('medium', 3, ['pepperoni', 'bacon'])] }); // (700 + 56 + 77) * 3
    expect(b.lines[0]).toMatchObject({ unitCents: 833, lineTotalCents: 2499 });
    expect(b.subtotalCents).toBe(2499);
  });

  it('adds up several different pizzas', () => {
    const b = price({ lines: [line('small'), line('large', 2, ['sausage'])] }); // 500 + 2 * (1200 + 96)
    expect(b.subtotalCents).toBe(500 + 2592);
  });

  it('records which price row each amount came from, for the order audit trail', () => {
    const l = price({ lines: [line('medium', 1, ['bacon'])] }).lines[0]!;
    expect(l.size.priceId).toBe(2);
    expect(l.toppings[0]!.priceId).toBe(6);
  });
});

describe('tax: 6.5% of the order, rounded half-up', () => {
  it('rounds .5 up: $5.00 -> 32.5 -> 33 cents', () => {
    const b = price({ lines: [line('small')] });
    expect(b).toMatchObject({ taxableCents: 500, taxRateBps: 650, taxCents: 33, totalCents: 533 });
  });

  it('rounds down below .5: 1666 * 6.5% = 108.29 -> 108', () => {
    const b = price({ lines: [line('medium', 2, ['pepperoni', 'bacon'])] });
    expect(b).toMatchObject({ subtotalCents: 1666, taxCents: 108, totalCents: 1774 });
  });

  it('follows the tax rate on the menu it was given', () => {
    expect(price({ lines: [line('small')] }, customMenu({ small: 500 }, 1000)).taxCents).toBe(50);
    expect(price({ lines: [line('small')] }, customMenu({ small: 500 }, 0)).taxCents).toBe(0);
  });

  it('is charged on the discounted amount, not the original', () => {
    const b = price({ lines: [line('small', 5)], promoCodes: ['SAVE5'] }); // 2500 - 500 = 2000
    expect(b.taxCents).toBe(130);
  });
});

describe('tip', () => {
  it('defaults to none', () => {
    expect(price({ lines: [line('small')] }).tip).toEqual({ mode: 'none', cents: 0, needsConfirmation: false });
  });

  it('a dollar tip is added as entered', () => {
    const b = price({ lines: [line('small')], tip: { mode: 'amount', cents: 500 } });
    expect(b.tip).toEqual({ mode: 'amount', cents: 500, needsConfirmation: false });
    expect(b.totalCents).toBe(533 + 500);
  });

  it('a percentage tip is a percentage of the total bill (after discount and tax)', () => {
    // large + pepperoni + bacon = 1428, ILOVEPIZZA -143 -> 1285, tax 84 -> bill 1369, 20% = 273.8 -> 274
    const b = price({ lines: [line('large', 1, ['pepperoni', 'bacon'])], promoCodes: ['ILOVEPIZZA'], tip: { mode: 'percent', bps: 2000 } });
    expect(b.tip.cents).toBe(274);
    expect(b.totalCents).toBe(1369 + 274);
  });

  it('rounds a percentage tip half-up', () => {
    // bill 533; 15% = 79.95 -> 80 ; 10% = 53.3 -> 53 ; 1% = 5.33 -> 5
    const tipFor = (bps: number) => price({ lines: [line('small')], tip: { mode: 'percent', bps } }).tip.cents;
    expect([tipFor(1500), tipFor(1000), tipFor(100)]).toEqual([80, 53, 5]);
  });

  describe('a very large tip is flagged for confirmation', () => {
    const big = (lines: ReturnType<typeof line>[], tip: OrderInput['tip'], promoCodes: string[] = []) =>
      price({ lines, tip, promoCodes }).tip.needsConfirmation;

    it('is not flagged for ordinary tips', () => {
      expect(big([line('large', 4)], { mode: 'percent', bps: 2000 })).toBe(false);
      expect(big([line('large', 4)], { mode: 'none' })).toBe(false);
    });

    it('is flagged at 50% or more on a bill of $40 or more', () => {
      // 4 large = 4800, tax 312, bill 5112
      expect(big([line('large', 4)], { mode: 'percent', bps: 5000 })).toBe(true);
      expect(big([line('large', 4)], { mode: 'percent', bps: 4999 })).toBe(false);
      expect(big([line('large', 4)], { mode: 'amount', cents: 2556 })).toBe(true); // exactly half of 5112
      expect(big([line('large', 4)], { mode: 'amount', cents: 2555 })).toBe(false);
    });

    it('is NOT flagged on a small order: a 100% tip on a $5 pizza is just $5.33', () => {
      expect(big([line('small')], { mode: 'percent', bps: 10_000 })).toBe(false);
      expect(big([line('small')], { mode: 'amount', cents: 500 })).toBe(false);
    });

    it('judges the bill after the discount and tax', () => {
      // 3 large + 1 medium = 4300; ILOVEPIZZA -430 -> 3870, tax 252 -> bill 4122: still over $40
      expect(big([line('large', 3), line('medium')], { mode: 'amount', cents: 2061 }, ['ILOVEPIZZA'])).toBe(true);
      // 3 large = 3600, tax 234 -> bill 3834, under $40: exempt even at a 100% tip
      expect(big([line('large', 3)], { mode: 'percent', bps: 10_000 })).toBe(false);
      // with SAVE5: 4300 - 500 = 3800, tax 247 -> bill 4047, still $40 or more; 50% of it is 2023.5 -> 2024
      expect(big([line('large', 3), line('medium')], { mode: 'percent', bps: 5000 }, ['SAVE5'])).toBe(true);
    });

    it('also holds for the percentage entered, not only the dollars', () => {
      const b = price({ lines: [line('large', 4)], tip: { mode: 'percent', bps: 8000 } });
      expect(b.tip).toEqual({ mode: 'percent', cents: 4090, needsConfirmation: true }); // 80% of 5112 = 4089.6
      expect(b.totalCents).toBe(5112 + 4090);
    });
  });

  it('zero is a valid tip', () => {
    expect(price({ lines: [line('small')], tip: { mode: 'amount', cents: 0 } }).tip.cents).toBe(0);
    expect(price({ lines: [line('small')], tip: { mode: 'percent', bps: 0 } }).tip.cents).toBe(0);
  });
});

describe('promo codes', () => {
  it('ILOVEPIZZA takes 10% off before tax', () => {
    // 1428 * 10% = 142.8 -> 143 ; taxable 1285 ; tax 83.525 -> 84 ; total 1369
    const b = price({ lines: [line('large', 1, ['pepperoni', 'bacon'])], promoCodes: ['ILOVEPIZZA'] });
    expect(b.discountCents).toBe(143);
    expect(b).toMatchObject({ taxableCents: 1285, taxCents: 84, totalCents: 1369 });
    expect(b.promos).toEqual([{ code: 'ILOVEPIZZA', applied: true, discountCents: 143 }]);
  });

  it('SAVE5 takes $5 off an order over $20', () => {
    const b = price({ lines: [line('small', 5)], promoCodes: ['SAVE5'] }); // 2500
    expect(b).toMatchObject({ discountCents: 500, taxableCents: 2000, taxCents: 130, totalCents: 2130 });
  });

  describe('SAVE5 threshold is strictly OVER $20.00, before tax', () => {
    it('exactly $20.00 does not qualify, and says why', () => {
      const b = price({ lines: [line('small')], promoCodes: ['SAVE5'] }, customMenu({ small: 2000 }));
      expect(b.discountCents).toBe(0);
      expect(b.promos).toEqual([{ code: 'SAVE5', applied: false, discountCents: 0, message: 'SAVE5 needs an order over $20.00 before tax' }]);
    });

    it('$20.01 qualifies', () => {
      // 2001 - 500 = 1501 ; tax 97.565 -> 98 ; total 1599
      const b = price({ lines: [line('small')], promoCodes: ['SAVE5'] }, customMenu({ small: 2001 }));
      expect(b).toMatchObject({ discountCents: 500, taxableCents: 1501, taxCents: 98, totalCents: 1599 });
    });

    it('is judged on the subtotal before any discount, not after', () => {
      // 2500 qualifies even though 2500 - 500 = 2000 is not itself "over $20"
      expect(price({ lines: [line('small', 5)], promoCodes: ['SAVE5'] }).promos[0]!.applied).toBe(true);
    });
  });

  describe('SAVE5 cannot be combined with ILOVEPIZZA', () => {
    const order = (promoCodes: string[]): OrderInput => ({ lines: [line('small', 5)], promoCodes }); // 2500

    it('the first code entered is kept, the second is refused with a clear message', () => {
      const a = price(order(['ILOVEPIZZA', 'SAVE5']));
      expect(a.discountCents).toBe(250);
      expect(a.promos).toEqual([
        { code: 'ILOVEPIZZA', applied: true, discountCents: 250 },
        { code: 'SAVE5', applied: false, discountCents: 0, message: 'SAVE5 cannot be combined with ILOVEPIZZA' },
      ]);

      const b = price(order(['SAVE5', 'ILOVEPIZZA']));
      expect(b.discountCents).toBe(500);
      expect(b.promos[1]).toMatchObject({ code: 'ILOVEPIZZA', applied: false, message: 'ILOVEPIZZA cannot be combined with SAVE5' });
    });

    it('a code that did not apply does not block the other one', () => {
      // 4 small = $20.00 exactly: SAVE5 does not qualify, so ILOVEPIZZA is free to apply
      const b = price({ lines: [line('small', 4)], promoCodes: ['SAVE5', 'ILOVEPIZZA'] });
      expect(b.promos.map((p) => [p.code, p.applied])).toEqual([['SAVE5', false], ['ILOVEPIZZA', true]]);
      expect(b.discountCents).toBe(200);
    });
  });

  it('ignores case, surrounding spaces, blank entries and repeats', () => {
    const b = price({ lines: [line('small', 5)], promoCodes: ['  ilovepizza ', '', 'ILOVEPIZZA'] });
    expect(b.promos).toEqual([{ code: 'ILOVEPIZZA', applied: true, discountCents: 250 }]);
  });

  it('an unknown code is refused with a message, and the order still prices', () => {
    const b = price({ lines: [line('small')], promoCodes: ['BOGUS'] });
    expect(b.promos).toEqual([{ code: 'BOGUS', applied: false, discountCents: 0, message: '"BOGUS" is not a valid promo code' }]);
    expect(b.totalCents).toBe(533);
  });

  it('never discounts below $0', () => {
    const huge: PromoDef = { code: 'FREE', kind: 'flat_off', percentBps: null, amountCents: 5000, minSubtotalCents: null, exclusive: true };
    const b = price({ lines: [line('small')], promoCodes: ['FREE'] }, briefMenu(), [huge]);
    expect(b).toMatchObject({ discountCents: 500, taxableCents: 0, taxCents: 0, totalCents: 0 });
  });

  it('non-exclusive promos stack, but never past the subtotal', () => {
    const a: PromoDef = { code: 'A', kind: 'flat_off', percentBps: null, amountCents: 300, minSubtotalCents: null, exclusive: false };
    const c: PromoDef = { code: 'C', kind: 'flat_off', percentBps: null, amountCents: 300, minSubtotalCents: null, exclusive: false };
    expect(price({ lines: [line('large')], promoCodes: ['A', 'C'] }, briefMenu(), [a, c]).discountCents).toBe(600);
    expect(price({ lines: [line('small')], promoCodes: ['A', 'C'] }, briefMenu(), [a, c]).discountCents).toBe(500);
  });

  it('an exclusive promo also blocks a non-exclusive one entered after it', () => {
    const open: PromoDef = { code: 'OPEN', kind: 'flat_off', percentBps: null, amountCents: 100, minSubtotalCents: null, exclusive: false };
    const b = price({ lines: [line('large')], promoCodes: ['ILOVEPIZZA', 'OPEN'] }, briefMenu(), [...briefPromos, open]);
    expect(b.promos[1]).toMatchObject({ applied: false, message: 'OPEN cannot be combined with ILOVEPIZZA' });
  });
});

describe('extensibility: new things without touching the engine', () => {
  it('a new promo of an existing kind is just data', () => {
    const summer: PromoDef = { code: 'SUMMER25', kind: 'percent_off', percentBps: 2500, amountCents: null, minSubtotalCents: 1000, exclusive: true };
    const b = price({ lines: [line('large')], promoCodes: ['SUMMER25'] }, briefMenu(), [...briefPromos, summer]); // 1200 -> 300 off
    expect(b.discountCents).toBe(300);
  });

  it('a brand-new promo kind is one registered strategy', () => {
    const half: PromoDef = { code: 'HALF', kind: 'half_off', percentBps: null, amountCents: null, minSubtotalCents: null, exclusive: true };
    const kinds = { ...DEFAULT_PROMO_KINDS, half_off: (_p: PromoDef, order: { subtotalCents: number }) => ({ discountCents: Math.floor(order.subtotalCents / 2) }) };
    const result = priceOrder({ lines: [line('large')], promoCodes: ['HALF'] }, briefMenu(), [half], kinds);
    expect(result.ok && result.breakdown.discountCents).toBe(600);
  });

  it('a line-specific promo kind works through the engine: it is handed the priced lines', () => {
    const kinds = {
      ...DEFAULT_PROMO_KINDS,
      // $2 off every large pizza
      large_off: (p: PromoDef, order: { lines: { size: { code: string }; quantity: number }[] }) => ({
        discountCents: (p.amountCents ?? 0) * order.lines.filter((l) => l.size.code === 'large').reduce((n, l) => n + l.quantity, 0),
      }),
    };
    const promo: PromoDef = { code: 'LARGE2', kind: 'large_off', percentBps: null, amountCents: 200, minSubtotalCents: null, exclusive: true };
    const r = priceOrder({ lines: [line('large', 2), line('small')], promoCodes: ['LARGE2'] }, briefMenu(), [promo], kinds);

    // subtotal 2900, discount 400, taxable 2500, tax 162.5 -> 163, total 2663
    expect(r.ok && r.breakdown).toMatchObject({ subtotalCents: 2900, discountCents: 400, taxableCents: 2500, taxCents: 163, totalCents: 2663 });
  });

  it.each([10.5, Number.NaN, -5])('a buggy promo kind returning a discount of %s is stopped, never turned into a charge', (discountCents) => {
    // The money helper refuses non-whole cents and the final consistency check refuses anything
    // that doesn't add up; whichever fires first, the engine throws instead of returning a price.
    const kinds = { ...DEFAULT_PROMO_KINDS, buggy: () => ({ discountCents }) };
    const buggy: PromoDef = { code: 'BUGGY', kind: 'buggy', percentBps: null, amountCents: null, minSubtotalCents: null, exclusive: true };
    expect(() => priceOrder({ lines: [line('large')], promoCodes: ['BUGGY'] }, briefMenu(), [buggy], kinds)).toThrow();
  });

  it('a promo whose kind is not registered is refused, not guessed at', () => {
    const odd: PromoDef = { code: 'ODD', kind: 'mystery', percentBps: null, amountCents: null, minSubtotalCents: null, exclusive: true };
    expect(price({ lines: [line('small')], promoCodes: ['ODD'] }, briefMenu(), [odd]).promos[0]).toMatchObject({ applied: false });
  });

  it('a new size and a new topping category work from data alone', () => {
    const menu = customMenu({ small: 500, xl: 1800 });
    menu.toppings.push({
      code: 'truffle', label: 'Truffle', category: { code: 'luxury', label: 'Luxury' },
      price: { type: 'percentage', amount: 2500 }, priceId: 99, pricesCents: { small: 125, xl: 450 },
    });
    const b = price({ lines: [line('xl', 1, ['truffle'])] }, menu);
    expect(b.subtotalCents).toBe(1800 + 450);
  });

  it('a flat-priced topping costs the same on every size', () => {
    const menu = briefMenu();
    menu.toppings.push({ code: 'gold', label: 'Gold leaf', category: null, price: { type: 'static', amount: 300 }, priceId: 98, pricesCents: { small: 300, medium: 300, large: 300 } });
    expect(price({ lines: [line('small', 1, ['gold'])] }, menu).subtotalCents).toBe(800);
    expect(price({ lines: [line('large', 1, ['gold'])] }, menu).subtotalCents).toBe(1500);
  });
});

describe('invalid orders: every problem is reported, with where and why', () => {
  it('refuses an empty order', () => {
    expect(issuesOf({ lines: [] })).toEqual([{ code: 'empty_order', path: 'lines', message: 'Add at least one pizza to your order' }]);
  });

  it.each([0, -1, 1.5, 101, Number.NaN, '2' as unknown as number])('refuses quantity %s', (quantity) => {
    expect(issuesOf({ lines: [line('small', quantity)] }).map((i) => i.code)).toEqual(['invalid_quantity']);
  });

  it('accepts the quantity limits themselves', () => {
    expect(price({ lines: [line('small', 1)] }).subtotalCents).toBe(500);
    expect(price({ lines: [line('small', LIMITS.maxQuantity)] }).subtotalCents).toBe(500 * LIMITS.maxQuantity);
  });

  it('refuses an unknown size and an unknown topping, naming them', () => {
    const issues = issuesOf({ lines: [line('xl', 1, ['mystery'])] });
    expect(issues.map((i) => i.code)).toEqual(['unknown_size', 'unknown_topping']);
    expect(issues[0]!.message).toBe('"xl" is not a size on the menu');
    expect(issues[1]).toMatchObject({ path: 'lines[0].toppings[0]', message: '"mystery" is not a topping on the menu' });
  });

  it('refuses the same topping twice on one pizza, but allows it on different pizzas', () => {
    expect(issuesOf({ lines: [line('small', 1, ['bacon', 'bacon'])] })[0]).toMatchObject({ code: 'duplicate_topping', path: 'lines[0].toppings[1]', message: 'Bacon is already on this pizza' });
    expect(price({ lines: [line('small', 1, ['bacon']), line('small', 1, ['bacon'])] }).subtotalCents).toBe(1110);
  });

  it('reports every problem at once, across lines and the tip', () => {
    const issues = issuesOf({
      lines: [line('xl', 0, ['mystery', 'bacon', 'bacon']), line('large', 2)],
      tip: { mode: 'amount', cents: -5 },
    });
    expect(issues.map((i) => `${i.path}:${i.code}`)).toEqual([
      'lines[0].quantity:invalid_quantity',
      'lines[0].size:unknown_size',
      'lines[0].toppings[0]:unknown_topping',
      'lines[0].toppings[2]:duplicate_topping',
      'tip:invalid_tip',
    ]);
  });

  it.each([
    [{ mode: 'amount', cents: -1 }, /\$0\.00 or more/],
    [{ mode: 'amount', cents: 1.5 }, /\$0\.00 or more/],
    [{ mode: 'amount', cents: LIMITS.maxTipCents + 1 }, /more than \$500\.00/],
    [{ mode: 'percent', bps: -1 }, /0% or more/],
    [{ mode: 'percent', bps: LIMITS.maxTipBps + 1 }, /more than 100%/],
    [{ mode: 'percent', bps: Number.NaN }, /0% or more/],
    [{ mode: 'bogus' }, /Choose no tip/],
  ])('refuses the tip %j with a clear message', (tip, message) => {
    const issues = issuesOf({ lines: [line('small')], tip: tip as OrderInput['tip'] });
    expect(issues).toHaveLength(1);
    expect(issues[0]!.code).toBe('invalid_tip');
    expect(issues[0]!.message).toMatch(message);
  });

  it('accepts the tip limits themselves', () => {
    expect(price({ lines: [line('small')], tip: { mode: 'amount', cents: LIMITS.maxTipCents } }).tip.cents).toBe(LIMITS.maxTipCents);
    expect(price({ lines: [line('small')], tip: { mode: 'percent', bps: LIMITS.maxTipBps } }).tip.cents).toBe(533);
  });

  it('survives garbage input without throwing', () => {
    const garbage = [
      null, undefined, 42, 'x', {}, { lines: 'no' }, { lines: [null] }, { lines: [{}] },
      { lines: [{ size: 5, quantity: 'a', toppings: 7 }] },
      { lines: [{ size: 'small', quantity: 1, toppings: [] }], promoCodes: 5 },
      { lines: [{ size: 'small', quantity: 1, toppings: [] }], promoCodes: [null, 7, {}] },
    ];
    for (const g of garbage) expect(() => priceOrder(g as unknown as OrderInput, briefMenu(), briefPromos)).not.toThrow();
  });
});

describe('properties that must hold for every order', () => {
  const menu = briefMenu();
  const sizeArb = fc.constantFrom('small', 'medium', 'large');
  const lineArb = fc.record({
    size: sizeArb,
    quantity: fc.integer({ min: 1, max: 20 }),
    toppings: fc.uniqueArray(fc.constantFrom('pepperoni', 'sausage', 'bacon', 'pineapple'), { maxLength: 4 }),
  });
  const tipArb = fc.oneof(
    fc.constant({ mode: 'none' as const }),
    fc.record({ mode: fc.constant('amount' as const), cents: fc.integer({ min: 0, max: 20_000 }) }),
    fc.record({ mode: fc.constant('percent' as const), bps: fc.integer({ min: 0, max: 5000 }) }),
  );
  const orderArb = fc.record({
    lines: fc.array(lineArb, { minLength: 1, maxLength: 6 }),
    tip: tipArb,
    promoCodes: fc.subarray(['ILOVEPIZZA', 'SAVE5', 'junk']),
  });

  const priced = (o: OrderInput) => {
    const r = priceOrder(o, menu, briefPromos);
    if (!r.ok) throw new Error('generated order should be valid');
    return r.breakdown;
  };

  it('the total is exactly subtotal - discount + tax + tip, in whole cents, never negative', () => {
    fc.assert(
      fc.property(orderArb, (order) => {
        const b = priced(order);
        expect(b.totalCents).toBe(b.subtotalCents - b.discountCents + b.taxCents + b.tip.cents);
        expect(b.discountCents).toBeLessThanOrEqual(b.subtotalCents);
        expect(b.totalCents).toBeGreaterThanOrEqual(0);
        for (const n of [b.subtotalCents, b.discountCents, b.taxCents, b.tip.cents, b.totalCents]) expect(Number.isSafeInteger(n)).toBe(true);
      }),
    );
  });

  it('the subtotal is the sum of the lines, and each line is unit x quantity', () => {
    fc.assert(
      fc.property(orderArb, (order) => {
        const b = priced(order);
        expect(b.subtotalCents).toBe(b.lines.reduce((s, l) => s + l.lineTotalCents, 0));
        for (const l of b.lines) {
          expect(l.lineTotalCents).toBe(l.unitCents * l.quantity);
          expect(l.unitCents).toBe(l.size.priceCents + l.toppings.reduce((s, t) => s + t.priceCents, 0));
        }
      }),
    );
  });

  it('tax and a percentage tip are each within half a cent of the exact amount', () => {
    fc.assert(
      fc.property(orderArb, (order) => {
        const b = priced(order);
        // |round(x) - exact| <= 1/2 cent, checked in integers: 2 * |result * 10000 - base * bps| <= 10000
        expect(2 * Math.abs(b.taxCents * 10_000 - b.taxableCents * b.taxRateBps)).toBeLessThanOrEqual(10_000);
        if (order.tip?.mode === 'percent') {
          const bill = b.taxableCents + b.taxCents;
          expect(2 * Math.abs(b.tip.cents * 10_000 - bill * order.tip.bps)).toBeLessThanOrEqual(10_000);
        }
      }),
    );
  });

  it('the order of the pizzas does not change any amount', () => {
    fc.assert(
      fc.property(orderArb, (order) => {
        const forward = priced(order);
        const reversed = priced({ ...order, lines: [...order.lines].reverse() });
        expect({ ...reversed, lines: [] }).toEqual({ ...forward, lines: [] });
      }),
    );
  });

  it('adding a topping or a pizza never lowers the subtotal', () => {
    fc.assert(
      fc.property(orderArb, lineArb, (order, extra) => {
        const before = priced({ ...order, promoCodes: [] }).subtotalCents;
        const after = priced({ ...order, promoCodes: [], lines: [...order.lines, extra] }).subtotalCents;
        expect(after).toBeGreaterThan(before);
      }),
    );
  });

  it('is deterministic: the same order always prices the same', () => {
    fc.assert(
      fc.property(orderArb, (order) => {
        expect(priced(order)).toEqual(priced(order));
      }),
    );
  });

  it('a promo never makes an order cost more', () => {
    fc.assert(
      fc.property(orderArb, (order) => {
        const without = priced({ ...order, promoCodes: [] });
        const withPromos = priced(order);
        expect(withPromos.totalCents - withPromos.tip.cents).toBeLessThanOrEqual(without.totalCents - without.tip.cents);
      }),
    );
  });
});

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { priceLines } from '../../src/core/lines.js';
import { applyPromos, DEFAULT_PROMO_KINDS, type PromoDef, type PromoOrder } from '../../src/core/promos.js';
import { briefMenu, briefPromos } from '../helpers/menu.js';

// The promo module on its own: a pre-tax subtotal and some codes in, discounts out.
// No menu, no pizzas, no tax. (How the engine uses it is covered in pricing.test.ts.)

const promo = (over: Partial<PromoDef> & { code: string }): PromoDef => ({
  kind: 'flat_off', percentBps: null, amountCents: 100, minSubtotalCents: null, exclusive: true, ...over,
});
/** A promo's view of an order when only the subtotal matters. */
const orderOf = (subtotalCents: number): PromoOrder => ({ subtotalCents, lines: [] });
const apply = (codes: unknown[], subtotal: number, promos: readonly PromoDef[] = briefPromos) =>
  applyPromos(codes, promos, orderOf(subtotal));

/** A real priced order from the menu, for promos that look at the lines. */
function pricedOrder(...lines: { size: string; quantity: number; toppings?: string[] }[]): PromoOrder {
  const r = priceLines(lines.map((l) => ({ toppings: [], ...l })), briefMenu());
  if (!r.ok) throw new Error('bad test order');
  return { subtotalCents: r.subtotalCents, lines: r.lines };
}

describe('percent_off (ILOVEPIZZA: 10% off)', () => {
  it.each([
    [2500, 250],
    [1428, 143], // 142.8 rounds up
    [1425, 143], // 142.5 rounds UP (half-up)
    [1424, 142], // 142.4 rounds down
    [5, 1], // 0.5 rounds up
    [4, 0], // 0.4 rounds down
    [0, 0],
  ])('takes the right amount off %i cents -> %i', (subtotal, off) => {
    const r = apply(['ILOVEPIZZA'], subtotal);
    expect(r.discountCents).toBe(off);
    expect(r.outcomes).toEqual([{ code: 'ILOVEPIZZA', applied: true, discountCents: off }]);
  });

  it('has no minimum: it applies to any order', () => {
    expect(apply(['ILOVEPIZZA'], 1).outcomes[0]!.applied).toBe(true);
  });
});

describe('flat_off with a minimum (SAVE5: $5 off an order over $20)', () => {
  it.each([
    [1999, false],
    [2000, false], // exactly $20.00: NOT over
    [2001, true], // $20.01
    [2500, true],
  ])('subtotal %i cents applies = %s', (subtotal, applies) => {
    const r = apply(['SAVE5'], subtotal);
    expect(r.outcomes[0]!.applied).toBe(applies);
    expect(r.discountCents).toBe(applies ? 500 : 0);
  });

  it('explains a refusal in dollars', () => {
    expect(apply(['SAVE5'], 2000).outcomes[0]!.message).toBe('SAVE5 needs an order over $20.00 before tax');
  });

  it('never takes off more than the order (a $5 promo on a $3 order)', () => {
    const cheap = promo({ code: 'CHEAP', amountCents: 500, minSubtotalCents: null });
    expect(apply(['CHEAP'], 300, [cheap]).discountCents).toBe(300);
  });

  it('a minimum of zero still means strictly over zero', () => {
    const p = promo({ code: 'Z', minSubtotalCents: 0 });
    expect(apply(['Z'], 0, [p]).outcomes[0]!.applied).toBe(false);
    expect(apply(['Z'], 1, [p]).outcomes[0]!.applied).toBe(true);
  });
});

describe('which codes count', () => {
  it('ignores case and surrounding spaces, and reports the code as stored', () => {
    expect(apply(['  ilovepizza '], 1000).outcomes).toEqual([{ code: 'ILOVEPIZZA', applied: true, discountCents: 100 }]);
  });

  it('ignores blank entries and repeats', () => {
    const r = apply(['', '   ', 'ILOVEPIZZA', 'ilovepizza', 'ILOVEPIZZA '], 1000);
    expect(r.outcomes).toHaveLength(1);
    expect(r.discountCents).toBe(100);
  });

  it('no codes means no discount and no outcomes', () => {
    expect(apply([], 1000)).toEqual({ outcomes: [], discountCents: 0 });
  });

  it('an unknown code is refused with its name in the message', () => {
    expect(apply(['NOPE'], 1000).outcomes).toEqual([{ code: 'NOPE', applied: false, discountCents: 0, message: '"NOPE" is not a valid promo code' }]);
  });

  it('tolerates codes that are not strings', () => {
    expect(() => apply([null, undefined, 7, {}, ['x']], 1000)).not.toThrow();
  });

  it('reports one outcome per distinct code, in the order entered', () => {
    const r = apply(['SAVE5', 'NOPE', 'ILOVEPIZZA'], 2500);
    expect(r.outcomes.map((o) => o.code)).toEqual(['SAVE5', 'NOPE', 'ILOVEPIZZA']);
  });
});

describe('combining promos', () => {
  const A = (exclusive: boolean) => promo({ code: 'A', exclusive });
  const B = (exclusive: boolean) => promo({ code: 'B', exclusive });

  it.each([
    // [A exclusive, B exclusive, both apply?]
    [true, true, false],
    [true, false, false],
    [false, true, false],
    [false, false, true],
  ])('A exclusive=%s, B exclusive=%s -> both apply: %s', (a, b, both) => {
    const r = apply(['A', 'B'], 1000, [A(a), B(b)]);
    expect(r.outcomes[0]!.applied).toBe(true); // the first code entered always wins
    expect(r.outcomes[1]!.applied).toBe(both);
    expect(r.discountCents).toBe(both ? 200 : 100);
  });

  it('names the promo that blocked it, for either order of entry', () => {
    expect(apply(['ILOVEPIZZA', 'SAVE5'], 2500).outcomes[1]!.message).toBe('SAVE5 cannot be combined with ILOVEPIZZA');
    expect(apply(['SAVE5', 'ILOVEPIZZA'], 2500).outcomes[1]!.message).toBe('ILOVEPIZZA cannot be combined with SAVE5');
  });

  it('a promo that did not apply (conditions unmet) does not block a later one', () => {
    const r = apply(['SAVE5', 'ILOVEPIZZA'], 2000); // SAVE5 needs OVER $20
    expect(r.outcomes.map((o) => [o.code, o.applied])).toEqual([['SAVE5', false], ['ILOVEPIZZA', true]]);
  });

  it('a promo that is unknown does not block a later one', () => {
    expect(apply(['NOPE', 'ILOVEPIZZA'], 1000).outcomes[1]!.applied).toBe(true);
  });

  it('stacked discounts are capped at the subtotal', () => {
    const open = [promo({ code: 'X', amountCents: 400, exclusive: false }), promo({ code: 'Y', amountCents: 400, exclusive: false })];
    const r = apply(['X', 'Y'], 600, open);
    expect(r.outcomes.map((o) => o.discountCents)).toEqual([400, 400]); // each reports its own amount
    expect(r.discountCents).toBe(600); // but the order cannot go below $0
  });
});

describe('promos that are not usable', () => {
  it('a percent promo with no percentage is refused, not applied as 0', () => {
    const broken = promo({ code: 'BROKEN', kind: 'percent_off', percentBps: null });
    expect(apply(['BROKEN'], 1000, [broken]).outcomes[0]).toMatchObject({ applied: false, message: 'This promo is not set up correctly' });
  });

  it('a flat promo with no amount is refused', () => {
    const broken = promo({ code: 'BROKEN', kind: 'flat_off', amountCents: null });
    expect(apply(['BROKEN'], 1000, [broken]).outcomes[0]!.applied).toBe(false);
  });

  it('a promo of a kind nobody registered is refused rather than guessed at', () => {
    const odd = promo({ code: 'ODD', kind: 'mystery' });
    expect(apply(['ODD'], 1000, [odd]).outcomes[0]).toMatchObject({ applied: false, message: 'This promo is not available right now' });
  });
});

describe('extending promos without changing the module', () => {
  it('a new promo of an existing kind is only data', () => {
    const summer = promo({ code: 'SUMMER', kind: 'percent_off', percentBps: 2500, amountCents: null, minSubtotalCents: 1000 });
    expect(apply(['SUMMER'], 1200, [summer]).discountCents).toBe(300);
    expect(apply(['SUMMER'], 1000, [summer]).outcomes[0]!.applied).toBe(false); // needs OVER $10
  });

  it('a new kind is one entry in the kinds table', () => {
    const kinds = { ...DEFAULT_PROMO_KINDS, half_off: (_p: PromoDef, order: PromoOrder) => ({ discountCents: Math.floor(order.subtotalCents / 2) }) };
    const half = promo({ code: 'HALF', kind: 'half_off' });
    expect(applyPromos(['HALF'], [half], orderOf(1001), kinds).discountCents).toBe(500);
  });

  it('a kind can refuse with its own message', () => {
    const kinds = { sorry: () => ({ reject: 'Not today' }) };
    expect(applyPromos(['S'], [promo({ code: 'S', kind: 'sorry' })], orderOf(1000), kinds).outcomes[0]!.message).toBe('Not today');
  });

  it('the generic minimum applies to every kind, including new ones', () => {
    const kinds = { free: () => ({ discountCents: 1 }) };
    const p = promo({ code: 'F', kind: 'free', minSubtotalCents: 500 });
    expect(applyPromos(['F'], [p], orderOf(500), kinds).outcomes[0]!.applied).toBe(false);
    expect(applyPromos(['F'], [p], orderOf(501), kinds).outcomes[0]!.applied).toBe(true);
  });
});

describe('line-specific promos: strategies are given the priced lines', () => {
  // "amountCents off every large pizza": a rule that needs the lines, not just the subtotal.
  const largeOff: Record<string, import('../../src/core/promos.js').PromoKind> = {
    large_off: (p, order) => {
      const larges = order.lines.filter((l) => l.size.code === 'large').reduce((n, l) => n + l.quantity, 0);
      return larges === 0 ? { reject: 'Add a large pizza to use this promo' } : { discountCents: larges * (p.amountCents ?? 0) };
    },
  };
  const LARGE2 = promo({ code: 'LARGE2', kind: 'large_off', amountCents: 200 });

  it('discounts only the lines it is about', () => {
    const order = pricedOrder({ size: 'large', quantity: 2 }, { size: 'small', quantity: 1 }, { size: 'large', quantity: 1, toppings: ['bacon'] });
    const r = applyPromos(['LARGE2'], [LARGE2], order, largeOff);
    expect(r.discountCents).toBe(3 * 200); // three large pizzas across two lines
    expect(r.outcomes).toEqual([{ code: 'LARGE2', applied: true, discountCents: 600 }]);
  });

  it('can refuse when the order has nothing it applies to, and says why', () => {
    const r = applyPromos(['LARGE2'], [LARGE2], pricedOrder({ size: 'small', quantity: 3 }), largeOff);
    expect(r.outcomes[0]).toMatchObject({ applied: false, message: 'Add a large pizza to use this promo' });
    expect(r.discountCents).toBe(0);
  });

  it('sees real priced lines: sizes, toppings, unit and line prices', () => {
    let seen: PromoOrder | undefined;
    const spy = { spy: (_p: PromoDef, order: PromoOrder) => ((seen = order), { discountCents: 0 }) };
    applyPromos(['S'], [promo({ code: 'S', kind: 'spy' })], pricedOrder({ size: 'medium', quantity: 2, toppings: ['bacon'] }), spy);

    expect(seen!.subtotalCents).toBe(1554); // (700 + 77) * 2
    expect(seen!.lines[0]).toMatchObject({ size: { code: 'medium' }, quantity: 2, unitCents: 777, lineTotalCents: 1554 });
    expect(seen!.lines[0]!.toppings.map((t) => t.code)).toEqual(['bacon']);
  });

  it('still applies the generic rules to a line-specific promo (minimum, exclusivity, cap)', () => {
    const order = pricedOrder({ size: 'large', quantity: 1 }); // $12.00
    const needsMore = promo({ code: 'BIG', kind: 'large_off', amountCents: 200, minSubtotalCents: 1200 });
    expect(applyPromos(['BIG'], [needsMore], order, largeOff).outcomes[0]!.applied).toBe(false); // not OVER $12.00

    const huge = promo({ code: 'HUGE', kind: 'large_off', amountCents: 99_999 });
    expect(applyPromos(['HUGE'], [huge], order, largeOff).discountCents).toBe(1200); // capped at the subtotal
  });
});

describe('strategies get a copy of the order, not the order', () => {
  it('a strategy that changes what it is given cannot alter the real order', () => {
    const order = pricedOrder({ size: 'large', quantity: 2 });
    const before = structuredClone(order);
    const vandal = {
      vandal: (_p: PromoDef, o: PromoOrder) => {
        o.subtotalCents = 0;
        o.lines.length = 0;
        return { discountCents: 1 };
      },
    };

    applyPromos(['V'], [promo({ code: 'V', kind: 'vandal' })], order, vandal);

    expect(order).toEqual(before);
  });

  it("one promo's changes are not seen by the next", () => {
    const order = pricedOrder({ size: 'large', quantity: 1 });
    const subtotals: number[] = [];
    const kinds = {
      meddle: (_p: PromoDef, o: PromoOrder) => ((o.subtotalCents = 7), { discountCents: 0 }),
      watch: (_p: PromoDef, o: PromoOrder) => (subtotals.push(o.subtotalCents), { discountCents: 0 }),
    };
    const promos = [
      promo({ code: 'M', kind: 'meddle', exclusive: false }),
      promo({ code: 'W', kind: 'watch', exclusive: false }),
    ];

    applyPromos(['M', 'W'], promos, order, kinds);

    expect(subtotals).toEqual([1200]);
  });
});

describe('hygiene', () => {
  it('does not modify what it is given', () => {
    const codes = ['SAVE5', 'ILOVEPIZZA'];
    const promos = structuredClone(briefPromos);
    const order = pricedOrder({ size: 'small', quantity: 5 });
    const orderBefore = structuredClone(order);
    applyPromos(codes, promos, order);
    expect(codes).toEqual(['SAVE5', 'ILOVEPIZZA']);
    expect(promos).toEqual(briefPromos);
    expect(order).toEqual(orderBefore);
  });
});

describe('properties', () => {
  const subtotal = fc.integer({ min: 0, max: 1_000_000 });
  const codes = fc.array(fc.constantFrom('ILOVEPIZZA', 'SAVE5', 'ilovepizza', ' save5 ', 'JUNK', ''), { maxLength: 6 });

  it('the discount is never negative and never more than the subtotal', () => {
    fc.assert(
      fc.property(codes, subtotal, (c, s) => {
        const { discountCents } = apply(c, s);
        expect(discountCents).toBeGreaterThanOrEqual(0);
        expect(discountCents).toBeLessThanOrEqual(s);
      }),
    );
  });

  it('with only exclusive promos (the brief), at most one is ever applied', () => {
    fc.assert(
      fc.property(codes, subtotal, (c, s) => {
        expect(apply(c, s).outcomes.filter((o) => o.applied).length).toBeLessThanOrEqual(1);
      }),
    );
  });

  it('every distinct non-blank code gets exactly one outcome', () => {
    fc.assert(
      fc.property(codes, subtotal, (c, s) => {
        const distinct = new Set(c.map((x) => x.trim().toUpperCase()).filter(Boolean));
        expect(apply(c, s).outcomes).toHaveLength(distinct.size);
      }),
    );
  });

  it('a refused code always explains itself; an applied one never carries a message', () => {
    fc.assert(
      fc.property(codes, subtotal, (c, s) => {
        for (const o of apply(c, s).outcomes) {
          if (o.applied) expect(o.message).toBeUndefined();
          else expect(o.message).toEqual(expect.any(String));
        }
      }),
    );
  });

  it('the result does not depend on how the same single code is written', () => {
    fc.assert(
      fc.property(subtotal, (s) => {
        expect(apply(['SAVE5'], s)).toEqual(apply(['  save5'], s));
      }),
    );
  });
});

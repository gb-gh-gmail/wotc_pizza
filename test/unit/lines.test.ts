import { describe, expect, it } from 'vitest';
import { priceLines } from '../../src/core/lines.js';
import { LIMITS } from '../../src/core/order.js';
import { briefMenu, customMenu } from '../helpers/menu.js';

// Stage 1 on its own: validate lines and price them. No promos, tax or tip.

const ok = (lines: unknown, menu = briefMenu()) => {
  const r = priceLines(lines, menu);
  if (!r.ok) throw new Error(`expected valid lines: ${r.issues.map((i) => i.message).join('; ')}`);
  return r;
};
const issues = (lines: unknown, menu = briefMenu()) => {
  const r = priceLines(lines, menu);
  if (r.ok) throw new Error('expected issues');
  return r.issues;
};
const one = (size: string, quantity = 1, toppings: string[] = []) => ({ size, quantity, toppings });

describe('pricing a line', () => {
  it.each([['small', 500], ['medium', 700], ['large', 1200]])('a plain %s is %i', (size, cents) => {
    const r = ok([one(size)]);
    expect(r.lines[0]).toMatchObject({ unitCents: cents, lineTotalCents: cents, quantity: 1, toppings: [] });
    expect(r.subtotalCents).toBe(cents);
  });

  it('adds each topping at its price for that size', () => {
    expect(ok([one('large', 1, ['pepperoni', 'bacon'])]).lines[0]).toMatchObject({ unitCents: 1200 + 96 + 132 });
    expect(ok([one('small', 1, ['pepperoni', 'bacon'])]).lines[0]).toMatchObject({ unitCents: 500 + 40 + 55 });
  });

  it('multiplies by quantity', () => {
    expect(ok([one('medium', 4, ['sausage'])]).lines[0]).toMatchObject({ unitCents: 756, lineTotalCents: 3024 });
  });

  it('keeps the toppings in the order given, with labels and price ids for the audit trail', () => {
    const line = ok([one('medium', 1, ['bacon', 'pepperoni'])]).lines[0]!;
    expect(line.toppings.map((t) => [t.code, t.label, t.priceCents, t.priceId])).toEqual([['bacon', 'Bacon', 77, 6], ['pepperoni', 'Pepperoni', 56, 4]]);
    expect(line.size).toEqual({ code: 'medium', label: 'Medium', priceCents: 700, priceId: 2 });
  });

  it('sums several lines into the subtotal, in order', () => {
    const r = ok([one('small'), one('large', 2, ['sausage']), one('medium')]);
    expect(r.lines.map((l) => l.lineTotalCents)).toEqual([500, 2592, 700]);
    expect(r.subtotalCents).toBe(3792);
  });

  it('prices from whatever menu it is given (a flat topping, a new size)', () => {
    const menu = customMenu({ small: 500, xl: 1800 });
    menu.toppings.push({ code: 'gold', label: 'Gold', category: null, price: { type: 'static', amount: 300 }, priceId: 9, pricesCents: { small: 300, xl: 300 } });
    expect(ok([one('xl', 1, ['gold'])], menu).subtotalCents).toBe(2100);
  });
});

describe('what it refuses, and how it says so', () => {
  it('an empty order', () => {
    expect(issues([])).toEqual([{ code: 'empty_order', path: 'lines', message: 'Add at least one pizza to your order' }]);
  });

  it('more lines than the limit, but exactly the limit is fine', () => {
    expect(ok(Array.from({ length: LIMITS.maxLines }, () => one('small'))).lines).toHaveLength(LIMITS.maxLines);
    expect(issues(Array.from({ length: LIMITS.maxLines + 1 }, () => one('small'))).map((i) => i.code)).toEqual(['too_many_lines']);
  });

  it.each([0, -3, 2.5, LIMITS.maxQuantity + 1, Number.NaN, Infinity, '2', null, undefined])('quantity %s', (q) => {
    // Built directly: the one() helper would turn an undefined quantity into its default of 1.
    expect(issues([{ size: 'small', quantity: q, toppings: [] }]).map((i) => i.code)).toEqual(['invalid_quantity']);
  });

  it.each([1, LIMITS.maxQuantity])('accepts quantity %i', (q) => {
    expect(ok([one('small', q)]).lines[0]!.quantity).toBe(q);
  });

  it('an unknown size, naming it; and a size that is not a string', () => {
    expect(issues([one('xl')])[0]).toEqual({ code: 'unknown_size', path: 'lines[0].size', message: '"xl" is not a size on the menu' });
    expect(issues([{ size: 5, quantity: 1, toppings: [] }])[0]!.code).toBe('unknown_size');
  });

  it('an unknown topping, pointing at it', () => {
    expect(issues([one('small', 1, ['bacon', 'mystery'])])).toEqual([
      { code: 'unknown_topping', path: 'lines[0].toppings[1]', message: '"mystery" is not a topping on the menu' },
    ]);
  });

  it('the same topping twice on one pizza, but not across pizzas', () => {
    expect(issues([one('small', 1, ['bacon', 'bacon'])])[0]).toMatchObject({ code: 'duplicate_topping', path: 'lines[0].toppings[1]' });
    expect(ok([one('small', 1, ['bacon']), one('small', 1, ['bacon'])]).subtotalCents).toBe(1110);
  });

  it('every problem on every line at once, each with its own path', () => {
    const found = issues([one('xl', 0, ['mystery', 'bacon', 'bacon']), one('large', 1, ['nope']), one('small')]);
    expect(found.map((i) => `${i.path} ${i.code}`)).toEqual([
      'lines[0].quantity invalid_quantity',
      'lines[0].size unknown_size',
      'lines[0].toppings[0] unknown_topping',
      'lines[0].toppings[2] duplicate_topping',
      'lines[1].toppings[0] unknown_topping',
    ]);
  });

  it('a pizza with problems is not priced, and neither is the order', () => {
    const r = priceLines([one('small'), one('xl')], briefMenu());
    expect(r.ok).toBe(false);
    expect('lines' in r).toBe(false);
  });
});

describe('robustness', () => {
  it.each([null, undefined, 42, 'x', {}, { 0: 'a' }, true])('lines = %j gives an issue, not an exception', (lines) => {
    expect(issues(lines).map((i) => i.code)).toEqual(['empty_order']);
  });

  it('survives lines that are not objects, and toppings that are not arrays', () => {
    expect(() => priceLines([null, 7, 'x', [], { size: 'small', quantity: 1, toppings: 'bacon' }], briefMenu())).not.toThrow();
    expect(ok([{ size: 'small', quantity: 1, toppings: 'bacon' }]).lines[0]!.toppings).toEqual([]);
  });

  it('does not change its input', () => {
    const input = [one('small', 2, ['bacon'])];
    const copy = structuredClone(input);
    priceLines(input, briefMenu());
    expect(input).toEqual(copy);
  });
});

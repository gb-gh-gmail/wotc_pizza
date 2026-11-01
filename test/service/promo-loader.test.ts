import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';
import { priceOrder, type OrderInput } from '../../src/core/pricing.js';
import { openDatabase } from '../../src/service/db.js';
import { getActiveMenu } from '../../src/service/menu/repo.js';
import { loadPromos } from '../../src/service/promos/repo.js';

const NOW = new Date('2026-06-15T12:00:00.000Z');
let db: DatabaseSync;
beforeEach(() => {
  db = openDatabase({ path: ':memory:', seed: true });
});
afterEach(() => db.close());

const insertPromo = (code: string, extra: { active?: number; starts?: string | null; ends?: string | null } = {}) =>
  db
    .prepare(
      `INSERT INTO promos (code, kind, amount_cents, active, starts_at, ends_at, created_at, updated_at)
       VALUES (?, 'flat_off', 100, ?, ?, ?, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
    )
    .run(code, extra.active ?? 1, extra.starts ?? null, extra.ends ?? null);
const codes = (at = NOW) => loadPromos(db, at).map((p) => p.code);

describe('which promos are available', () => {
  it('the seed has exactly the two promos from the brief, set up as the brief describes', () => {
    expect(loadPromos(db, NOW)).toEqual([
      { code: 'ILOVEPIZZA', kind: 'percent_off', percentBps: 1000, amountCents: null, minSubtotalCents: null, exclusive: true },
      { code: 'SAVE5', kind: 'flat_off', percentBps: null, amountCents: 500, minSubtotalCents: 2000, exclusive: true },
    ]);
  });

  it('leaves out a promo that is switched off', () => {
    db.exec(`UPDATE promos SET active = 0 WHERE code = 'SAVE5'`);
    expect(codes()).toEqual(['ILOVEPIZZA']);
  });

  it('honours the start and end of a promo window (start inclusive, end exclusive)', () => {
    insertPromo('SUMMER', { starts: '2026-07-01T00:00:00.000Z', ends: '2026-08-01T00:00:00.000Z' });
    expect(codes(new Date('2026-06-30T23:59:59.999Z'))).not.toContain('SUMMER');
    expect(codes(new Date('2026-07-01T00:00:00.000Z'))).toContain('SUMMER');
    expect(codes(new Date('2026-07-31T23:59:59.999Z'))).toContain('SUMMER');
    expect(codes(new Date('2026-08-01T00:00:00.000Z'))).not.toContain('SUMMER');
  });

  it('a promo with no dates is always available, one with only a start or only an end works too', () => {
    insertPromo('OPEN_START', { starts: '2026-01-01T00:00:00.000Z' });
    insertPromo('OPEN_END', { ends: '2027-01-01T00:00:00.000Z' });
    expect(codes()).toEqual(expect.arrayContaining(['ILOVEPIZZA', 'OPEN_START', 'OPEN_END']));
    expect(codes(new Date('2028-01-01T00:00:00.000Z'))).not.toContain('OPEN_END');
  });

  it('the database only accepts canonical timestamps for a promo window', () => {
    expect(() => insertPromo('BAD', { starts: '2026-07-01' })).toThrow(/CHECK/i);
  });
});

describe("the REAL seeded promos and menu, through the engine (the brief's rules, end to end)", () => {
  const menu = () => getActiveMenu(db, NOW)!;
  const price = (order: OrderInput) => {
    const r = priceOrder(order, menu(), loadPromos(db, NOW));
    if (!r.ok) throw new Error(r.issues.map((i) => i.message).join('; '));
    return r.breakdown;
  };
  const smalls = (n: number, promoCodes: string[]): OrderInput => ({ lines: [{ size: 'small', quantity: n, toppings: [] }], promoCodes });

  it('ILOVEPIZZA: 10% off before tax', () => {
    const b = price({ lines: [{ size: 'large', quantity: 1, toppings: ['pepperoni', 'bacon'] }], promoCodes: ['ILOVEPIZZA'] });
    expect(b).toMatchObject({ subtotalCents: 1428, discountCents: 143, taxCents: 84, totalCents: 1369 });
  });

  it('SAVE5: $5 off an order over $20, and not at exactly $20', () => {
    expect(price(smalls(5, ['SAVE5']))).toMatchObject({ subtotalCents: 2500, discountCents: 500, totalCents: 2130 });
    const exactly = price(smalls(4, ['SAVE5'])); // 4 x $5.00 = $20.00
    expect(exactly.discountCents).toBe(0);
    expect(exactly.promos[0]).toMatchObject({ applied: false, message: 'SAVE5 needs an order over $20.00 before tax' });
  });

  it('SAVE5 cannot be combined with ILOVEPIZZA, whichever is entered first', () => {
    const a = price(smalls(5, ['ILOVEPIZZA', 'SAVE5']));
    expect(a.promos.map((p) => [p.code, p.applied])).toEqual([['ILOVEPIZZA', true], ['SAVE5', false]]);
    const b = price(smalls(5, ['SAVE5', 'ILOVEPIZZA']));
    expect(b.promos.map((p) => [p.code, p.applied])).toEqual([['SAVE5', true], ['ILOVEPIZZA', false]]);
  });

  it('a promo switched off in the database stops applying on the very next pricing', () => {
    expect(price(smalls(5, ['SAVE5'])).promos[0]!.applied).toBe(true);
    db.exec(`UPDATE promos SET active = 0 WHERE code = 'SAVE5'`);
    const after = price(smalls(5, ['SAVE5']));
    expect(after.promos[0]).toMatchObject({ applied: false, message: '"SAVE5" is not a valid promo code' });
    expect(after.discountCents).toBe(0);
  });
});

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { DatabaseSync } from 'node:sqlite';
import { buildApp } from '../../src/service/app.js';
import { openDatabase } from '../../src/service/db.js';

const T0 = new Date('2026-06-15T12:00:00.000Z');
const at = (minutes: number) => new Date(T0.getTime() + minutes * 60_000);

let db: DatabaseSync;
let app: FastifyInstance;
let clock: Date;

beforeEach(() => {
  clock = T0;
  db = openDatabase({ path: ':memory:', seed: true });
  app = buildApp({ db, now: () => clock });
});
afterEach(async () => {
  await app.close();
  db.close();
});

const loadMenu = async () => (await app.inject({ method: 'GET', url: '/menu' })).json();
const post = (body: object) => app.inject({ method: 'POST', url: '/quote', payload: body });
const line = (size: string, quantity = 1, toppings: string[] = []) => ({ size, quantity, toppings });

/** Load the menu, then quote an order against it. */
async function quote(order: object, claimed?: object) {
  const { menuToken } = await loadMenu();
  const res = await post({ menuToken, order, ...(claimed ? { claimed } : {}) });
  return { res, body: res.json(), menuToken };
}

describe('POST /quote: the full breakdown', () => {
  it('prices a plain pizza: subtotal, tax, total, and no promo block', async () => {
    const { res, body } = await quote({ lines: [line('small')] });

    expect(res.statusCode).toBe(200);
    expect(body.quote).toMatchObject({ subtotalCents: 500, discountCents: 0, taxableCents: 500, taxCents: 33, totalCents: 533, withoutPromo: null });
    expect(body.matches).toBe(true);
    expect(body.differences).toEqual([]);
  });

  it('echoes the token and the deadline, and the server clock', async () => {
    const { body, menuToken } = await quote({ lines: [line('small')] });
    expect(body).toMatchObject({ menuToken, expiresAt: at(30).toISOString(), serverTime: T0.toISOString() });
  });

  it('with a promo that applies, gives the totals with AND without it', async () => {
    const { body } = await quote({ lines: [line('large', 1, ['pepperoni', 'bacon'])], promoCodes: ['ILOVEPIZZA'] });

    expect(body.quote).toMatchObject({ subtotalCents: 1428, discountCents: 143, taxCents: 84, totalCents: 1369 });
    expect(body.quote.promos).toEqual([{ code: 'ILOVEPIZZA', applied: true, discountCents: 143 }]);
    // without the promo: tax 6.5% of 1428 = 92.82 -> 93, total 1521
    expect(body.quote.withoutPromo).toEqual({ taxableCents: 1428, taxCents: 93, tipCents: 0, totalCents: 1521 });
  });

  it('a percentage tip is worked out on the discounted bill, and on the undiscounted bill for the comparison', async () => {
    const { body } = await quote({ lines: [line('large', 1, ['pepperoni', 'bacon'])], promoCodes: ['ILOVEPIZZA'], tip: { mode: 'percent', bps: 2000 } });
    expect(body.quote).toMatchObject({ totalCents: 1369 + 274 }); // 20% of 1369 = 273.8
    expect(body.quote.withoutPromo).toMatchObject({ tipCents: 304, totalCents: 1521 + 304 }); // 20% of 1521 = 304.2
  });

  it('a dollar tip is added as entered', async () => {
    const { body } = await quote({ lines: [line('small')], tip: { mode: 'amount', cents: 500 } });
    expect(body.quote).toMatchObject({ tip: { mode: 'amount', cents: 500 }, totalCents: 1033 });
  });

  it('writes nothing: no order, no extra snapshot', async () => {
    await quote({ lines: [line('small')] });
    await quote({ lines: [line('large', 3)] });
    expect(db.prepare(`SELECT COUNT(*) AS n FROM orders`).get()).toEqual({ n: 0 });
    expect(db.prepare(`SELECT COUNT(*) AS n FROM menu_snapshots`).get()).toEqual({ n: 1 }); // just the one the menu load made
  });
});

describe('tips', () => {
  it('flags a tip of half the bill or more, so the page can ask the customer to confirm it', async () => {
    // 4 large = 4800 + 312 tax = 5112; a $30 tip is more than half
    const { body } = await quote({ lines: [line('large', 4)], tip: { mode: 'amount', cents: 3000 } });
    expect(body.quote.tip).toEqual({ mode: 'amount', cents: 3000, needsConfirmation: true });
    expect(body.quote.totalCents).toBe(5112 + 3000);
  });

  it('does not flag an ordinary tip, or a big share of a small order', async () => {
    expect((await quote({ lines: [line('large', 4)], tip: { mode: 'percent', bps: 2000 } })).body.quote.tip.needsConfirmation).toBe(false);
    expect((await quote({ lines: [line('small')], tip: { mode: 'amount', cents: 500 } })).body.quote.tip.needsConfirmation).toBe(false);
  });

  it.each([
    ['a negative dollar tip', { mode: 'amount', cents: -100 }, 'Tip must be a dollar amount of $0.00 or more'],
    ['a negative percentage', { mode: 'percent', bps: -1 }, 'Tip must be a percentage of 0% or more'],
    ['more than $500', { mode: 'amount', cents: 50_001 }, 'Tip cannot be more than $500.00'],
    ['more than 100%', { mode: 'percent', bps: 10_001 }, 'Tip cannot be more than 100%'],
  ])('refuses %s with a clear message', async (_label, tip, message) => {
    const { res, body } = await quote({ lines: [line('small')], tip });
    expect(res.statusCode).toBe(422);
    expect(body.issues).toEqual([{ code: 'invalid_tip', path: 'tip', message }]);
  });
});

describe('promos are re-validated on every quote', () => {
  const smalls = (n: number) => ({ lines: [line('small', n)], promoCodes: ['SAVE5'] });

  it('a code that applied stops applying when the order changes, with the reason and the new price', async () => {
    const { menuToken } = await loadMenu();
    const five = (await post({ menuToken, order: smalls(5) })).json().quote; // $25.00
    expect(five).toMatchObject({ discountCents: 500, totalCents: 2130 });
    expect(five.promos[0].applied).toBe(true);

    // The customer removes a pizza: $20.00 is no longer OVER $20.
    const four = (await post({ menuToken, order: smalls(4) })).json().quote;
    expect(four.promos).toEqual([{ code: 'SAVE5', applied: false, discountCents: 0, message: 'SAVE5 needs an order over $20.00 before tax' }]);
    expect(four).toMatchObject({ subtotalCents: 2000, discountCents: 0, totalCents: 2130, withoutPromo: null });
  });

  it('a promo switched off in the meantime is refused on the next quote', async () => {
    const { menuToken } = await loadMenu();
    expect((await post({ menuToken, order: smalls(5) })).json().quote.promos[0].applied).toBe(true);

    db.exec(`UPDATE promos SET active = 0 WHERE code = 'SAVE5'`);

    const after = (await post({ menuToken, order: smalls(5) })).json().quote;
    expect(after.promos[0]).toMatchObject({ applied: false, message: '"SAVE5" is not a valid promo code' });
    expect(after.discountCents).toBe(0);
    expect(after.totalCents).toBe(2663); // 2500 + 163 tax, no discount
  });

  it('a promo that expires in the meantime is refused, even though the menu prices are still held', async () => {
    db.prepare(`UPDATE promos SET ends_at = ? WHERE code = 'SAVE5'`).run(at(10).toISOString());
    const { menuToken } = await loadMenu();
    expect((await post({ menuToken, order: smalls(5) })).json().quote.promos[0].applied).toBe(true);

    clock = at(10); // the promo ends; the 30-minute menu session has 20 minutes left
    const after = await post({ menuToken, order: smalls(5) });
    expect(after.statusCode).toBe(200);
    expect(after.json().quote.promos[0].applied).toBe(false);
  });

  it('both codes entered: the second is refused and named', async () => {
    const { body } = await quote({ lines: [line('small', 5)], promoCodes: ['SAVE5', 'ILOVEPIZZA'] });
    expect(body.quote.promos.map((p: { code: string; applied: boolean }) => [p.code, p.applied])).toEqual([['SAVE5', true], ['ILOVEPIZZA', false]]);
    expect(body.quote.promos[1].message).toBe('ILOVEPIZZA cannot be combined with SAVE5');
  });

  it('an unknown code is reported, and the order still prices', async () => {
    const { res, body } = await quote({ lines: [line('small')], promoCodes: ['NOPE'] });
    expect(res.statusCode).toBe(200);
    expect(body.quote.promos).toEqual([{ code: 'NOPE', applied: false, discountCents: 0, message: '"NOPE" is not a valid promo code' }]);
    expect(body.quote.totalCents).toBe(533);
  });
});

describe('prices are the ones the customer was shown', () => {
  const raiseLarge = (cents: number) => {
    const id = (db.prepare(`SELECT id FROM menu_items WHERE code = 'large'`).get() as { id: number }).id;
    db.prepare(`UPDATE prices SET effective_to = ? WHERE menu_item_id = ? AND effective_to IS NULL`).run(clock.toISOString(), id);
    db.prepare(`INSERT INTO prices (menu_item_id, price_type, amount, effective_from) VALUES (?, 'static', ?, ?)`).run(id, cents, clock.toISOString());
  };

  it('a price rise after the menu was loaded does not change that customer\'s quote', async () => {
    const earlier = await loadMenu(); // 12:00, large is $12.00
    clock = at(5);
    raiseLarge(1300);

    // The customer who loaded the menu at 12:00 is still quoted $12.00 (and 8% of it for toppings)...
    const held = (await post({ menuToken: earlier.menuToken, order: { lines: [line('large', 1, ['pepperoni'])] } })).json();
    expect(held.quote.subtotalCents).toBe(1200 + 96);
    // ...while a customer loading the menu now sees and is quoted the new price.
    const fresh = await loadMenu();
    const now = (await post({ menuToken: fresh.menuToken, order: { lines: [line('large', 1, ['pepperoni'])] } })).json();
    expect(now.quote.subtotalCents).toBe(1300 + 104);
  });

  it('a page still showing the old price is told it differs only against the new menu', async () => {
    const earlier = await loadMenu();
    clock = at(5);
    raiseLarge(1300);
    const fresh = await loadMenu();
    const claimed = { subtotalCents: 1200, lines: [{ unitCents: 1200 }] };

    expect((await post({ menuToken: earlier.menuToken, order: { lines: [line('large')] }, claimed })).json().matches).toBe(true);

    const against = (await post({ menuToken: fresh.menuToken, order: { lines: [line('large')] }, claimed })).json();
    expect(against.matches).toBe(false);
    expect(against.differences.map((d: { message: string }) => d.message)).toEqual([
      'Pizza 1: you were shown $12.00 each, but it is $13.00 each',
      'Subtotal: you were shown $12.00, but it is $13.00',
    ]);
  });
});

describe('checking what the page shows against the service', () => {
  const order = { lines: [line('large', 1, ['pepperoni', 'bacon'])], promoCodes: ['ILOVEPIZZA'] };

  it('matches when every figure is right', async () => {
    const { body } = await quote(order, {
      lines: [{ unitCents: 1428 }], subtotalCents: 1428, discountCents: 143, taxCents: 84, tipCents: 0, totalCents: 1369,
    });
    expect(body.matches).toBe(true);
    expect(body.differences).toEqual([]);
  });

  it('says exactly what differs, in dollars, including when a promo no longer applies', async () => {
    // The page believes SAVE5 took $5 off, so it shows a total of $20.30 (but the service refuses SAVE5 at this size)
    const { body } = await quote(
      { lines: [line('small', 4)], promoCodes: ['SAVE5'] },
      { subtotalCents: 2000, discountCents: 500, taxCents: 98, totalCents: 1598 },
    );
    expect(body.matches).toBe(false);
    expect(body.differences.map((d: { message: string }) => d.message)).toEqual([
      'Discount: you were shown $5.00, but it is $0.00',
      'Tax: you were shown $0.98, but it is $1.30',
      'Total: you were shown $15.98, but it is $21.30',
    ]);
    // ...and the same response carries the corrected quote for the page to display
    expect(body.quote).toMatchObject({ totalCents: 2130 });
    expect(body.quote.promos[0]).toMatchObject({ applied: false });
  });

  it('flags a different number of pizza lines', async () => {
    const { body } = await quote({ lines: [line('small')] }, { lines: [{ unitCents: 500 }, { unitCents: 500 }] });
    expect(body.matches).toBe(false);
    expect(body.differences[0].message).toBe('Your order has 1 pizza line(s), but 2 were shown');
  });

  it('only checks what the page claims', async () => {
    const { body } = await quote({ lines: [line('small')] }, { totalCents: 533 });
    expect(body.matches).toBe(true);
  });

  it('treats a claim of the wrong type as a difference, not a crash', async () => {
    const { res, body } = await quote({ lines: [line('small')] }, { totalCents: '5.33', subtotalCents: null });
    expect(res.statusCode).toBe(200);
    expect(body.matches).toBe(false);
  });
});

describe('POST /quote: when it cannot quote', () => {
  it('a token that has expired is refused with a message about the timeout', async () => {
    const { menuToken } = await loadMenu();
    clock = at(30); // exactly the deadline
    const res = await post({ menuToken, order: { lines: [line('small')] } });

    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: 'menu_expired', expiredAt: at(30).toISOString(), serverTime: at(30).toISOString() });
    expect(res.json().message).toMatch(/timed out/i);
  });

  it('is still honoured one millisecond before the deadline', async () => {
    const { menuToken } = await loadMenu();
    clock = new Date(at(30).getTime() - 1);
    expect((await post({ menuToken, order: { lines: [line('small')] } })).statusCode).toBe(200);
  });

  it('a token the service never issued is refused', async () => {
    const res = await post({ menuToken: 'made-up', order: { lines: [line('small')] } });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('menu_unknown');
  });

  it('an invalid order gets every problem at once, with where each is', async () => {
    const { res, body } = await quote({ lines: [line('xl', 0, ['mystery'])], tip: { mode: 'amount', cents: -5 } });

    expect(res.statusCode).toBe(422);
    expect(body.error).toBe('invalid_order');
    expect(body.issues.map((i: { path: string; code: string }) => `${i.path} ${i.code}`)).toEqual([
      'lines[0].quantity invalid_quantity',
      'lines[0].size unknown_size',
      'lines[0].toppings[0] unknown_topping',
      'tip invalid_tip',
    ]);
  });

  it('an empty order is refused with a clear message', async () => {
    const { res, body } = await quote({ lines: [] });
    expect(res.statusCode).toBe(422);
    expect(body.issues[0].message).toBe('Add at least one pizza to your order');
  });

  it.each([
    ['no token', { order: { lines: [] } }],
    ['no order', { menuToken: 'x' }],
    ['an order that is not an object', { menuToken: 'x', order: 'pizza' }],
    ['an empty token', { menuToken: '', order: {} }],
  ])('rejects a malformed request: %s', async (_label, body) => {
    expect((await post(body)).statusCode).toBe(400);
  });

  it('fields it does not know about are thrown away and never used (a client cannot send its own discount)', async () => {
    const { menuToken } = await loadMenu();
    const res = await post({ menuToken, order: { lines: [line('small')] }, discount: 100, totalCents: 1, price: 0 });
    expect(res.statusCode).toBe(200);
    expect(res.json().quote).toMatchObject({ discountCents: 0, totalCents: 533 });
  });

  it('the menu being unavailable does not make a held quote fail', async () => {
    const { menuToken } = await loadMenu();
    db.exec(`UPDATE menus SET active = 0`); // the menu is switched off after the customer loaded it
    expect((await post({ menuToken, order: { lines: [line('small')] } })).statusCode).toBe(200);
  });
});

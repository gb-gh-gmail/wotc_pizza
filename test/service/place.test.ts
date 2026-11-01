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
let keyCounter = 0;

beforeEach(() => {
  clock = T0;
  keyCounter = 0;
  db = openDatabase({ path: ':memory:', seed: true });
  app = buildApp({ db, now: () => clock });
});
afterEach(async () => {
  await app.close();
  db.close();
});

const line = (size: string, quantity = 1, toppings: string[] = []) => ({ size, quantity, toppings });
const newKey = () => `test-key-${++keyCounter}`;
const count = (table: string) => (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
const loadMenu = async () => (await app.inject({ method: 'GET', url: '/menu' })).json();

type Order = { lines: ReturnType<typeof line>[]; tip?: object; promoCodes?: string[] };
type Quote = {
  lines: { unitCents: number }[]; subtotalCents: number; discountCents: number; taxCents: number; totalCents: number; tip: { cents: number };
};

/** What the page would claim after checking its total. */
const claimedOf = (q: Quote) => ({
  lines: q.lines.map((l) => ({ unitCents: l.unitCents })),
  subtotalCents: q.subtotalCents,
  discountCents: q.discountCents,
  taxCents: q.taxCents,
  tipCents: q.tip.cents,
  totalCents: q.totalCents,
});
const quoteOf = async (menuToken: string, order: Order) =>
  (await app.inject({ method: 'POST', url: '/quote', payload: { menuToken, order } })).json().quote as Quote;

/** `key` null sends no Idempotency-Key header at all (an undefined would just take the default). */
const post = (body: object, key: string | null = newKey()) =>
  app.inject({ method: 'POST', url: '/orders', payload: body, headers: key === null ? {} : { 'idempotency-key': key } });

/** Load the menu, check the total as the page would, and place the order with exactly that claim. */
async function placeChecked(order: Order, extra: { key?: string; confirmations?: object } = {}) {
  const { menuToken } = await loadMenu();
  const quote = await quoteOf(menuToken, order);
  const res = await post({ menuToken, order, claimed: claimedOf(quote), ...(extra.confirmations ? { confirmations: extra.confirmations } : {}) }, extra.key ?? newKey());
  return { res, body: res.json(), menuToken, quote };
}

describe('placing an order that checks out', () => {
  const order: Order = { lines: [line('large', 1, ['pepperoni', 'bacon'])], promoCodes: ['ILOVEPIZZA'], tip: { mode: 'none' } };

  it('creates the order and says where to find it', async () => {
    const { res, body } = await placeChecked(order);

    expect(res.statusCode).toBe(201);
    expect(body.replayed).toBe(false);
    expect(body.trackPath).toBe(`/track/${body.order.id}`);
    expect(res.headers.location).toBe(`/orders/${body.order.id}`);
    expect(body.order).toMatchObject({ status: 'NOT_STARTED', totalCents: 1369, canCancel: true });
    expect(body.order).not.toHaveProperty('nextStatus'); // the customer's view
  });

  it('stores exactly what was quoted, with the prices and promo it used', async () => {
    const { body, menuToken, quote } = await placeChecked(order);
    const row = db.prepare(`SELECT * FROM orders WHERE id = ?`).get(body.order.id) as Record<string, unknown>;

    expect(row).toMatchObject({
      status: 'NOT_STARTED', version: 1, menu_snapshot_token: menuToken, tip_mode: 'none', tip_input: 0,
      subtotal_cents: 1428, discount_cents: 143, tax_cents: 84, tip_cents: 0, total_cents: 1369, created_at: T0.toISOString(),
    });
    expect(row.total_cents).toBe(quote.totalCents);
    expect(row.tax_rate_id).toBe(1);

    const items = db.prepare(`SELECT * FROM order_items WHERE order_id = ?`).all(body.order.id) as unknown as { id: number; price_id: number }[];
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ position: 0, quantity: 1, base_price_cents: 1200, unit_price_cents: 1428, line_total_cents: 1428 });
    expect(items[0]!.price_id).toBeGreaterThan(0);

    const toppings = db.prepare(`SELECT m.code, t.price_cents, t.price_id FROM order_item_toppings t JOIN menu_items m ON m.id = t.topping_item_id WHERE t.order_item_id = ? ORDER BY m.sort_order`).all(items[0]!.id) as { code: string; price_cents: number; price_id: number }[];
    expect(toppings.map((t) => [t.code, t.price_cents])).toEqual([['pepperoni', 96], ['bacon', 132]]);
    expect(toppings.every((t) => t.price_id > 0)).toBe(true);

    expect(db.prepare(`SELECT p.code, op.discount_cents FROM order_promos op JOIN promos p ON p.id = op.promo_id WHERE op.order_id = ?`).all(body.order.id)).toEqual([{ code: 'ILOVEPIZZA', discount_cents: 143 }]);
  });

  it('records who created it and when', async () => {
    const { body } = await placeChecked(order);
    expect(db.prepare(`SELECT from_status, to_status, actor, at FROM order_status_events WHERE order_id = ?`).all(body.order.id)).toEqual([
      { from_status: null, to_status: 'NOT_STARTED', actor: 'customer', at: T0.toISOString() },
    ]);
  });

  it('the new order shows up for the kitchen and on the status page, as the customer ordered it', async () => {
    const { body } = await placeChecked(order);

    const kitchen = (await app.inject({ method: 'GET', url: '/kitchen/orders' })).json().orders;
    expect(kitchen).toHaveLength(1);
    expect(kitchen[0]).toMatchObject({ id: body.order.id, status: 'NOT_STARTED', totalCents: 1369, nextStatus: 'STARTED' });
    expect(kitchen[0].items).toEqual([{ quantity: 1, size: 'Large', toppings: ['Pepperoni', 'Bacon'] }]);

    const status = (await app.inject({ method: 'GET', url: `/orders/${body.order.id}` })).json();
    expect(status.order).toMatchObject({ id: body.order.id, status: 'NOT_STARTED', canCancel: true });
  });

  it('the customer can then cancel it, and the kitchen is told', async () => {
    const { body } = await placeChecked(order);
    const cancelled = await app.inject({ method: 'POST', url: `/orders/${body.order.id}/cancel`, payload: { reason: 'changed my mind', expectedStatus: 'NOT_STARTED' } });
    expect(cancelled.statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url: `/kitchen/orders/${body.order.id}/advance`, payload: { expectedStatus: 'NOT_STARTED' } })).json().error).toBe('order_cancelled');
  });

  it('stores a dollar tip and a percentage tip as the customer entered them', async () => {
    const dollars = await placeChecked({ lines: [line('small')], tip: { mode: 'amount', cents: 250 } });
    const percent = await placeChecked({ lines: [line('small')], tip: { mode: 'percent', bps: 1800 } });
    const rows = db.prepare(`SELECT tip_mode, tip_input, tip_cents, total_cents FROM orders ORDER BY created_at, rowid`).all();
    expect(rows).toEqual([
      { tip_mode: 'amount', tip_input: 250, tip_cents: 250, total_cents: 783 },
      { tip_mode: 'percent', tip_input: 1800, tip_cents: 96, total_cents: 629 }, // 18% of 533 = 95.94
    ]);
    expect([dollars.res.statusCode, percent.res.statusCode]).toEqual([201, 201]);
  });

  it('what is charged is always what was quoted, for a range of orders', async () => {
    const orders: Order[] = [
      { lines: [line('small')] },
      { lines: [line('medium', 3, ['sausage', 'pineapple']), line('large')], tip: { mode: 'percent', bps: 1500 } },
      { lines: [line('small', 5)], promoCodes: ['SAVE5'], tip: { mode: 'amount', cents: 300 } },
      { lines: [line('large', 2, ['bacon'])], promoCodes: ['ilovepizza'] },
    ];
    for (const o of orders) {
      const { res, body, quote } = await placeChecked(o);
      expect(res.statusCode).toBe(201);
      const row = db.prepare(`SELECT subtotal_cents s, discount_cents d, tax_cents x, tip_cents t, total_cents total FROM orders WHERE id = ?`).get(body.order.id) as unknown as { s: number; d: number; x: number; t: number; total: number };
      expect(row.total).toBe(quote.totalCents);
      expect(row.total).toBe(row.s - row.d + row.x + row.t);
    }
  });
});

describe('a retry never places the order twice', () => {
  const order: Order = { lines: [line('large', 2, ['bacon'])] };

  it('the same key and order returns the same order (200, replayed), and writes nothing more', async () => {
    const first = await placeChecked(order, { key: 'retry-key-1' });
    const again = await post({ menuToken: first.menuToken, order, claimed: claimedOf(first.quote) }, 'retry-key-1');

    expect(first.res.statusCode).toBe(201);
    expect(again.statusCode).toBe(200);
    expect(again.json()).toMatchObject({ replayed: true, order: { id: first.body.order.id } });
    expect([count('orders'), count('order_items'), count('order_status_events'), count('idempotency_keys')]).toEqual([1, 1, 1, 1]);
  });

  it('a lost response and a retry after the session has expired still gets the original order', async () => {
    const first = await placeChecked(order, { key: 'retry-key-2' });
    clock = at(45); // well past the 30-minute window
    const again = await post({ menuToken: first.menuToken, order, claimed: claimedOf(first.quote) }, 'retry-key-2');

    expect(again.statusCode).toBe(200);
    expect(again.json().order.id).toBe(first.body.order.id);
  });

  it('is recognised even if the claimed figures differ on the retry', async () => {
    const first = await placeChecked(order, { key: 'retry-key-3' });
    const again = await post({ menuToken: first.menuToken, order, claimed: { subtotalCents: 1, totalCents: 1 } }, 'retry-key-3');
    expect(again.json().order.id).toBe(first.body.order.id);
    expect(count('orders')).toBe(1);
  });

  it('a key reused for a DIFFERENT order is refused, not answered with the wrong order', async () => {
    const first = await placeChecked(order, { key: 'retry-key-4' });
    const other: Order = { lines: [line('small')] };
    const res = await post({ menuToken: first.menuToken, order: other, claimed: claimedOf(await quoteOf(first.menuToken, other)) }, 'retry-key-4');

    expect(res.statusCode).toBe(422);
    expect(res.json().error).toBe('idempotency_key_reused');
    expect(count('orders')).toBe(1);
  });

  it('a new key is a new submission: the same order placed deliberately twice is two orders', async () => {
    await placeChecked(order, { key: 'retry-key-5' });
    await placeChecked(order, { key: 'retry-key-6' });
    expect(count('orders')).toBe(2);
  });

  it.each([null, '', 'short', 'has spaces in it', 'x'.repeat(101), 'bad/char!'])('refuses a missing or malformed key: %j', async (key) => {
    const { menuToken } = await loadMenu();
    const quote = await quoteOf(menuToken, order);
    const res = await post({ menuToken, order, claimed: claimedOf(quote) }, key);
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('idempotency_key_required');
    expect(count('orders')).toBe(0);
  });
});

describe('a mismatch holds the order until the customer confirms', () => {
  const order: Order = { lines: [line('large', 1, ['pepperoni', 'bacon'])], promoCodes: ['ILOVEPIZZA'] };

  it('prices that differ from what the page showed: 409, the corrected quote, and nothing is written', async () => {
    const { menuToken } = await loadMenu();
    const quote = await quoteOf(menuToken, order);
    const res = await post({ menuToken, order, claimed: { ...claimedOf(quote), totalCents: 1000 } });

    expect(res.statusCode).toBe(409);
    const body = res.json();
    expect(body).toMatchObject({ error: 'confirmation_required', reasons: ['prices_changed'], removedPromos: [] });
    expect(body.quote.totalCents).toBe(1369);
    expect(body.differences.map((d: { message: string }) => d.message)).toEqual(['Total: you were shown $10.00, but it is $13.69']);
    expect([count('orders'), count('idempotency_keys'), count('order_status_events')]).toEqual([0, 0, 0]);
  });

  it('OK: the same order resubmitted with the updated figures (same key) is placed', async () => {
    const { menuToken } = await loadMenu();
    const key = 'confirm-key-1';
    const stale = { ...claimedOf(await quoteOf(menuToken, order)), totalCents: 1000 };

    const held = await post({ menuToken, order, claimed: stale }, key);
    expect(held.statusCode).toBe(409);

    // The customer pressed OK: the page now claims the figures the service just returned.
    const accepted = await post({ menuToken, order, claimed: claimedOf(held.json().quote) }, key);
    expect(accepted.statusCode).toBe(201);
    expect(accepted.json().order.totalCents).toBe(1369);
    expect(count('orders')).toBe(1);
  });

  it('Cancel: the customer simply does not resubmit, and nothing was ever created', async () => {
    const { menuToken } = await loadMenu();
    await post({ menuToken, order, claimed: { subtotalCents: 1, totalCents: 1 } });
    expect([count('orders'), count('order_items'), count('idempotency_keys')]).toEqual([0, 0, 0]);
  });

  it('a line price that differs is reported against that pizza', async () => {
    const { menuToken } = await loadMenu();
    const quote = await quoteOf(menuToken, order);
    const res = await post({ menuToken, order, claimed: { ...claimedOf(quote), lines: [{ unitCents: 1300 }] } });
    expect(res.json().differences.map((d: { message: string }) => d.message)).toEqual(['Pizza 1: you were shown $13.00 each, but it is $14.28 each']);
  });

  it('a promo that was applied and no longer is: held, naming the code, with the new total', async () => {
    const five: Order = { lines: [line('small', 5)], promoCodes: ['SAVE5'] };
    const { menuToken } = await loadMenu();
    const claimed = claimedOf(await quoteOf(menuToken, five)); // total 2130 with SAVE5
    db.exec(`UPDATE promos SET active = 0 WHERE code = 'SAVE5'`); // switched off while the customer was deciding

    const res = await post({ menuToken, order: five, claimed });

    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ reasons: ['prices_changed', 'promo_removed'], removedPromos: ['SAVE5'] });
    expect(res.json().quote.totalCents).toBe(2663); // 2500 + 163 tax, no discount
    expect(count('orders')).toBe(0);
  });

  it('a promo that stops qualifying because the order shrank is held too', async () => {
    const { menuToken } = await loadMenu();
    const claimed = claimedOf(await quoteOf(menuToken, { lines: [line('small', 5)], promoCodes: ['SAVE5'] }));
    const res = await post({ menuToken, order: { lines: [line('small', 4)], promoCodes: ['SAVE5'] }, claimed });
    expect(res.statusCode).toBe(409);
    expect(res.json().reasons).toContain('promo_removed');
  });

  it('a code that was never valid is held, so the customer is not told one thing and charged another', async () => {
    const o: Order = { lines: [line('small')], promoCodes: ['NOPE'] };
    const { menuToken } = await loadMenu();
    const claimed = claimedOf(await quoteOf(menuToken, o));
    const res = await post({ menuToken, order: o, claimed });
    expect(res.json()).toMatchObject({ error: 'confirmation_required', reasons: ['promo_removed'], removedPromos: ['NOPE'] });
  });

  it('no figures at all are trusted from the client: a stray total cannot set the stored total', async () => {
    const { menuToken } = await loadMenu();
    const quote = await quoteOf(menuToken, order);
    const res = await post({ menuToken, order, claimed: claimedOf(quote), total_cents: 1, totalCents: 1, price: 0 });
    expect(res.statusCode).toBe(201);
    expect((db.prepare(`SELECT total_cents t FROM orders`).get() as { t: number }).t).toBe(1369);
  });
});

describe('the price the customer was shown is the price they pay', () => {
  const raiseLarge = (cents: number) => {
    const id = (db.prepare(`SELECT id FROM menu_items WHERE code = 'large'`).get() as { id: number }).id;
    db.prepare(`UPDATE prices SET effective_to = ? WHERE menu_item_id = ? AND effective_to IS NULL`).run(clock.toISOString(), id);
    db.prepare(`INSERT INTO prices (menu_item_id, price_type, amount, effective_from) VALUES (?, 'static', ?, ?)`).run(id, cents, clock.toISOString());
  };
  const plainLarge: Order = { lines: [line('large')] };

  it('a price rise after the menu was loaded does not change what an earlier customer pays', async () => {
    const early = await loadMenu();
    const earlyQuote = await quoteOf(early.menuToken, plainLarge); // $12.00 + tax = $12.78
    clock = at(5);
    raiseLarge(1300);

    const res = await post({ menuToken: early.menuToken, order: plainLarge, claimed: claimedOf(earlyQuote) });

    expect(res.statusCode).toBe(201);
    expect(res.json().order.totalCents).toBe(1278);
    expect(db.prepare(`SELECT unit_price_cents u FROM order_items`).get()).toEqual({ u: 1200 });
  });

  it('but a customer on the NEW menu who still shows the old price is held, with the new price', async () => {
    const early = await loadMenu();
    const oldClaim = claimedOf(await quoteOf(early.menuToken, plainLarge));
    clock = at(5);
    raiseLarge(1300);
    const fresh = await loadMenu();

    const res = await post({ menuToken: fresh.menuToken, order: plainLarge, claimed: oldClaim });

    expect(res.statusCode).toBe(409);
    expect(res.json().quote.subtotalCents).toBe(1300);
    expect(count('orders')).toBe(0);
  });
});

describe('a very large tip must be confirmed', () => {
  const bigTip: Order = { lines: [line('large', 4)], tip: { mode: 'amount', cents: 3000 } }; // bill $51.12, tip $30.00

  it('is held when the customer has not confirmed it', async () => {
    const { res, body } = await placeChecked(bigTip);
    expect(res.statusCode).toBe(409);
    expect(body).toMatchObject({ reasons: ['large_tip'], differences: [] });
    expect(body.quote.tip).toEqual({ mode: 'amount', cents: 3000, needsConfirmation: true });
    expect(count('orders')).toBe(0);
  });

  it('is placed when the customer confirmed exactly that amount', async () => {
    const { res, body } = await placeChecked(bigTip, { confirmations: { largeTipCents: 3000 } });
    expect(res.statusCode).toBe(201);
    expect(body.order.totalCents).toBe(5112 + 3000);
    expect(db.prepare(`SELECT tip_mode, tip_input, tip_cents FROM orders`).get()).toEqual({ tip_mode: 'amount', tip_input: 3000, tip_cents: 3000 });
  });

  it('a confirmation of a DIFFERENT amount does not count (the tip changed after they confirmed)', async () => {
    const { res, body } = await placeChecked(bigTip, { confirmations: { largeTipCents: 2000 } });
    expect(res.statusCode).toBe(409);
    expect(body.reasons).toEqual(['large_tip']);
  });

  it('a percentage tip is confirmed by the dollar amount it works out to', async () => {
    const pct: Order = { lines: [line('large', 4)], tip: { mode: 'percent', bps: 6000 } }; // 60% of 5112 = 3067.2
    expect((await placeChecked(pct)).res.statusCode).toBe(409);
    const ok = await placeChecked(pct, { confirmations: { largeTipCents: 3067 } });
    expect(ok.res.statusCode).toBe(201);
    expect(db.prepare(`SELECT tip_mode, tip_input, tip_cents FROM orders`).get()).toEqual({ tip_mode: 'percent', tip_input: 6000, tip_cents: 3067 });
  });

  it('is not needed on a small order: a $5 tip on a $5.33 bill goes straight through', async () => {
    expect((await placeChecked({ lines: [line('small')], tip: { mode: 'amount', cents: 500 } })).res.statusCode).toBe(201);
  });

  it('an ordinary tip needs no confirmation, and a needless confirmation is harmless', async () => {
    const ordinary: Order = { lines: [line('large', 4)], tip: { mode: 'percent', bps: 2000 } };
    expect((await placeChecked(ordinary)).res.statusCode).toBe(201);
    expect((await placeChecked(ordinary, { confirmations: { largeTipCents: 999 } })).res.statusCode).toBe(201);
  });

  it('a large tip AND a price change are both reported', async () => {
    const { menuToken } = await loadMenu();
    const claimed = { ...claimedOf(await quoteOf(menuToken, bigTip)), totalCents: 1 };
    const res = await post({ menuToken, order: bigTip, claimed });
    expect(res.json().reasons).toEqual(['prices_changed', 'large_tip']);
  });
});

describe('bad data is rejected, and nothing is written', () => {
  it('an invalid order: 422 with every problem and where it is', async () => {
    const { menuToken } = await loadMenu();
    const res = await post({
      menuToken,
      order: { lines: [line('xl', 0, ['mystery'])], tip: { mode: 'amount', cents: -5 } },
      claimed: { subtotalCents: 0, totalCents: 0 },
    });

    expect(res.statusCode).toBe(422);
    expect(res.json().issues.map((i: { path: string; code: string }) => `${i.path} ${i.code}`)).toEqual([
      'lines[0].quantity invalid_quantity',
      'lines[0].size unknown_size',
      'lines[0].toppings[0] unknown_topping',
      'tip invalid_tip',
    ]);
    expect(count('orders')).toBe(0);
  });

  it('an empty order', async () => {
    const { menuToken } = await loadMenu();
    const res = await post({ menuToken, order: { lines: [] }, claimed: { subtotalCents: 0, totalCents: 0 } });
    expect(res.statusCode).toBe(422);
    expect(res.json().issues[0].message).toBe('Add at least one pizza to your order');
  });

  it('an expired session: 409, nothing written', async () => {
    const { menuToken } = await loadMenu();
    clock = at(30);
    const res = await post({ menuToken, order: { lines: [line('small')] }, claimed: { subtotalCents: 500, totalCents: 533 } });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('menu_expired');
    expect(count('orders')).toBe(0);
  });

  it('still fine one millisecond before the deadline', async () => {
    const { menuToken } = await loadMenu();
    const quote = await quoteOf(menuToken, { lines: [line('small')] });
    clock = new Date(at(30).getTime() - 1);
    expect((await post({ menuToken, order: { lines: [line('small')] }, claimed: claimedOf(quote) })).statusCode).toBe(201);
  });

  it('a session the service never issued', async () => {
    const res = await post({ menuToken: 'made-up', order: { lines: [line('small')] }, claimed: { subtotalCents: 500, totalCents: 533 } });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('menu_unknown');
  });

  it.each([
    ['no token', { order: { lines: [line('small')] }, claimed: { subtotalCents: 500, totalCents: 533 } }],
    ['no order', { menuToken: 'x', claimed: { subtotalCents: 500, totalCents: 533 } }],
    ['no claimed figures', { menuToken: 'x', order: { lines: [line('small')] } }],
    ['no claimed total', { menuToken: 'x', order: { lines: [line('small')] }, claimed: { subtotalCents: 500 } }],
    ['no claimed subtotal', { menuToken: 'x', order: { lines: [line('small')] }, claimed: { totalCents: 533 } }],
    ['a claimed total that is not a whole number', { menuToken: 'x', order: { lines: [line('small')] }, claimed: { subtotalCents: 500, totalCents: 5.33 } }],
    ['a claimed total that is text', { menuToken: 'x', order: { lines: [line('small')] }, claimed: { subtotalCents: 500, totalCents: '533' } }],
  ])('a malformed request is refused with 400: %s', async (_label, body) => {
    expect((await post(body)).statusCode).toBe(400);
    expect(count('orders')).toBe(0);
  });
});

describe('placing is all-or-nothing', () => {
  it('a failure part-way leaves no order, no lines and no key, and a retry then works', async () => {
    const order: Order = { lines: [line('large', 2, ['bacon', 'pepperoni']), line('small')], promoCodes: ['ILOVEPIZZA'] };
    const { menuToken } = await loadMenu();
    const claimed = claimedOf(await quoteOf(menuToken, order));

    // Make the very last write (the first status event) fail, after everything else was written.
    db.exec(`CREATE TRIGGER boom BEFORE INSERT ON order_status_events BEGIN SELECT RAISE(ABORT, 'boom'); END`);
    const failed = await post({ menuToken, order, claimed }, 'atomic-key-1');
    expect(failed.statusCode).toBe(500);
    expect([count('orders'), count('order_items'), count('order_item_toppings'), count('order_promos'), count('order_status_events'), count('idempotency_keys')]).toEqual([0, 0, 0, 0, 0, 0]);

    // The key was not consumed by the failure, so the same request now succeeds.
    db.exec(`DROP TRIGGER boom`);
    const retried = await post({ menuToken, order, claimed }, 'atomic-key-1');
    expect(retried.statusCode).toBe(201);
    expect([count('orders'), count('order_items'), count('order_status_events')]).toEqual([1, 2, 1]);
  });
});

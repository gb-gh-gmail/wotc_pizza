import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { DatabaseSync } from 'node:sqlite';
import { buildApp } from '../../src/service/app.js';
import { openDatabase } from '../../src/service/db.js';
import { purgeExpiredSnapshots } from '../../src/service/menu/snapshots.js';

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
const newKey = () => `upd-key-${++keyCounter}`;
const count = (table: string) => (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;

type Order = { lines: ReturnType<typeof line>[]; tip?: object; promoCodes?: string[] };
type Quote = { lines: { unitCents: number }[]; subtotalCents: number; discountCents: number; taxCents: number; totalCents: number; tip: { cents: number } };

const claimedOf = (q: Quote) => ({
  lines: q.lines.map((l) => ({ unitCents: l.unitCents })),
  subtotalCents: q.subtotalCents, discountCents: q.discountCents, taxCents: q.taxCents, tipCents: q.tip.cents, totalCents: q.totalCents,
});
const loadMenu = async () => (await app.inject({ method: 'GET', url: '/menu' })).json();
const quoteOf = async (menuToken: string, order: Order) => (await app.inject({ method: 'POST', url: '/quote', payload: { menuToken, order } })).json().quote as Quote;
const viewOf = async (id: string) => (await app.inject({ method: 'GET', url: `/orders/${id}` })).json().order;

/** Place an order the way the page does. */
async function place(order: Order) {
  const { menuToken } = await loadMenu();
  const quote = await quoteOf(menuToken, order);
  const res = await app.inject({ method: 'POST', url: '/orders', headers: { 'idempotency-key': newKey() }, payload: { menuToken, order, claimed: claimedOf(quote) } });
  expect(res.statusCode).toBe(201);
  const body = res.json();
  return { id: body.order.id as string, version: body.order.version as number, total: body.order.totalCents as number };
}

const put = (id: string, body: object, key: string | null = newKey()) =>
  app.inject({ method: 'PUT', url: `/orders/${id}`, payload: body, headers: key === null ? {} : { 'idempotency-key': key } });

/** Change an order the way the page does: a fresh menu, check the total, then save with those figures. */
async function change(id: string, expectedVersion: number, order: Order, extra: { key?: string; confirmations?: object } = {}) {
  const { menuToken } = await loadMenu();
  const quote = await quoteOf(menuToken, order);
  const res = await put(id, { menuToken, order, claimed: claimedOf(quote), expectedVersion, ...(extra.confirmations ? { confirmations: extra.confirmations } : {}) }, extra.key ?? newKey());
  return { res, body: res.json(), quote, menuToken };
}

const original: Order = { lines: [line('small')] }; // $5.00 + tax = $5.33
const next: Order = { lines: [line('large', 2, ['bacon'])], promoCodes: ['ILOVEPIZZA'], tip: { mode: 'amount', cents: 300 } };
// 2 x (1200 + 132) = 2664 ; ILOVEPIZZA -266 ; taxable 2398 ; tax 156 ; tip 300 ; total 2854

describe('the order, as the customer can read it back', () => {
  it('shows each line with its codes and prices, how the total is made up, and that it has not changed', async () => {
    const placed = await place({ lines: [line('large', 1, ['pepperoni', 'bacon'])], promoCodes: ['ILOVEPIZZA'], tip: { mode: 'percent', bps: 1800 } });
    const order = await viewOf(placed.id);

    expect(order.lines).toEqual([
      { size: { code: 'large', label: 'Large' }, quantity: 1, toppings: [{ code: 'pepperoni', label: 'Pepperoni' }, { code: 'bacon', label: 'Bacon' }], unitCents: 1428, lineTotalCents: 1428 },
    ]);
    expect(order.pricing).toEqual({
      subtotalCents: 1428, discountCents: 143, taxCents: 84,
      tip: { mode: 'percent', input: 1800, cents: 246 }, // 18% of 1369 = 246.42
      totalCents: 1615, promos: [{ code: 'ILOVEPIZZA', discountCents: 143 }],
    });
    expect(order).toMatchObject({ revision: 1, original: { totalCents: 1615 }, canEdit: true, canCancel: true });
  });

  it('can no longer be edited once the kitchen has started it', async () => {
    const placed = await place(original);
    await app.inject({ method: 'POST', url: `/kitchen/orders/${placed.id}/advance`, payload: { expectedStatus: 'NOT_STARTED' } });
    expect((await viewOf(placed.id)).canEdit).toBe(false);
  });
});

describe('changing an order that has not been started', () => {
  it('replaces its contents and prices, bumps the version, and says what the total was before', async () => {
    const placed = await place(original);
    const { res, body, quote } = await change(placed.id, placed.version, next);

    expect(res.statusCode).toBe(200);
    expect(quote.totalCents).toBe(2854);
    expect(body).toMatchObject({ unchanged: false, replayed: false, previousTotalCents: 533, trackPath: `/track/${placed.id}` });
    expect(body.order).toMatchObject({ status: 'NOT_STARTED', version: placed.version + 1, totalCents: 2854, revision: 2, original: { totalCents: 533 } });
    expect(body.order).not.toHaveProperty('nextStatus');
    expect(body.order.pricing).toMatchObject({ subtotalCents: 2664, discountCents: 266, taxCents: 156, tip: { mode: 'amount', input: 300, cents: 300 }, promos: [{ code: 'ILOVEPIZZA', discountCents: 266 }] });
  });

  it('really replaces the old lines, toppings and promos, with nothing left over', async () => {
    const placed = await place({ lines: [line('small', 3, ['pepperoni']), line('medium')], promoCodes: ['SAVE5'] });
    expect(count('order_items')).toBe(2);
    await change(placed.id, placed.version, next);

    const rows = db.prepare(`SELECT o.position, m.code, o.quantity, o.unit_price_cents u FROM order_items o JOIN menu_items m ON m.id = o.size_item_id WHERE o.order_id = ?`).all(placed.id);
    expect(rows).toEqual([{ position: 0, code: 'large', quantity: 2, u: 1332 }]);
    expect(count('order_item_toppings')).toBe(1); // just the new bacon
    expect(db.prepare(`SELECT p.code FROM order_promos op JOIN promos p ON p.id = op.promo_id`).all()).toEqual([{ code: 'ILOVEPIZZA' }]);
    expect(db.prepare(`SELECT tip_mode, tip_input, tip_cents, total_cents FROM orders`).get()).toEqual({ tip_mode: 'amount', tip_input: 300, tip_cents: 300, total_cents: 2854 });
  });

  it('keeps every version: the original is still what it was, and prices come from the menu each version used', async () => {
    const placed = await place(original);
    const first = await change(placed.id, placed.version, next);
    const second = await change(placed.id, first.body.order.version, { lines: [line('medium')] });

    expect(second.res.statusCode).toBe(200);
    const revisions = db.prepare(`SELECT revision, total_cents t, subtotal_cents s FROM order_revisions WHERE order_id = ? ORDER BY revision`).all(placed.id);
    expect(revisions).toEqual([{ revision: 1, t: 533, s: 500 }, { revision: 2, t: 2854, s: 2664 }, { revision: 3, t: 746, s: 700 }]); // $7.00 + 6.5% tax (45.5 rounds up to 46)
    expect(second.body.order).toMatchObject({ revision: 3, original: { totalCents: 533 } }); // "originally $5.33" survives every edit
  });

  it('is not a status change: the status history is untouched and the kitchen sees the new order', async () => {
    const placed = await place(original);
    await change(placed.id, placed.version, next);

    expect(db.prepare(`SELECT from_status, to_status FROM order_status_events WHERE order_id = ?`).all(placed.id)).toEqual([{ from_status: null, to_status: 'NOT_STARTED' }]);
    const kitchen = (await app.inject({ method: 'GET', url: '/kitchen/orders' })).json().orders[0];
    expect(kitchen).toMatchObject({ id: placed.id, totalCents: 2854, status: 'NOT_STARTED' });
    expect(kitchen.items).toEqual([{ quantity: 2, size: 'Large', toppings: ['Bacon'] }]);
  });

  it('can add a promo, change the tip, and take both away again', async () => {
    const placed = await place(original);
    const withExtras = await change(placed.id, placed.version, { lines: [line('small', 5)], promoCodes: ['SAVE5'], tip: { mode: 'percent', bps: 2000 } });
    expect(withExtras.body.order.pricing.promos).toEqual([{ code: 'SAVE5', discountCents: 500 }]);

    const stripped = await change(placed.id, withExtras.body.order.version, { lines: [line('small', 5)] });
    expect(stripped.body.order.pricing).toMatchObject({ discountCents: 0, promos: [], tip: { mode: 'none', input: 0, cents: 0 } });
    expect(count('order_promos')).toBe(0);
  });
});

describe('how a change compares with the order as it stands', () => {
  it('prices the whole order on today\'s menu: an unchanged pizza follows a price rise, and the customer is shown the difference first', async () => {
    const placed = await place({ lines: [line('large')] }); // $12.00 + $0.78 = $12.78
    clock = at(5);
    const id = (db.prepare(`SELECT id FROM menu_items WHERE code = 'large'`).get() as { id: number }).id;
    db.prepare(`UPDATE prices SET effective_to = ? WHERE menu_item_id = ? AND effective_to IS NULL`).run(clock.toISOString(), id);
    db.prepare(`INSERT INTO prices (menu_item_id, price_type, amount, effective_from) VALUES (?, 'static', 1300, ?)`).run(id, clock.toISOString());

    // The page quotes the same order on the fresh menu and shows 12.78 -> 13.85 before saving.
    const { res, body, quote } = await change(placed.id, placed.version, { lines: [line('large')] });
    expect(quote).toMatchObject({ subtotalCents: 1300, totalCents: 1385 });
    expect(res.statusCode).toBe(200);
    expect(body).toMatchObject({ previousTotalCents: 1278, unchanged: false });
    expect(body.order.original).toEqual({ totalCents: 1278 }); // what they first paid for is still on record
  });

  it('a change is priced at the prices the customer was shown for the change, not later ones', async () => {
    const placed = await place({ lines: [line('large')] });
    const shown = await loadMenu();
    const quote = await quoteOf(shown.menuToken, { lines: [line('large', 2)] });
    clock = at(5);
    const id = (db.prepare(`SELECT id FROM menu_items WHERE code = 'large'`).get() as { id: number }).id;
    db.prepare(`UPDATE prices SET effective_to = ? WHERE menu_item_id = ? AND effective_to IS NULL`).run(clock.toISOString(), id);
    db.prepare(`INSERT INTO prices (menu_item_id, price_type, amount, effective_from) VALUES (?, 'static', 1500, ?)`).run(id, clock.toISOString());

    const res = await put(placed.id, { menuToken: shown.menuToken, order: { lines: [line('large', 2)] }, claimed: claimedOf(quote), expectedVersion: placed.version });
    expect(res.statusCode).toBe(200);
    expect(res.json().order.totalCents).toBe(2556); // 2 x $12.00 = 2400 + 156 tax: the price they were shown
  });

  it('saving an order that is identical changes nothing and records nothing', async () => {
    const placed = await place({ lines: [line('medium', 2, ['sausage'])] });
    const { res, body } = await change(placed.id, placed.version, { lines: [line('medium', 2, ['sausage'])] });

    expect(res.statusCode).toBe(200);
    expect(body).toMatchObject({ unchanged: true, previousTotalCents: placed.total });
    expect(body.order).toMatchObject({ version: placed.version, revision: 1 });
    expect(count('order_revisions')).toBe(1);
  });
});

describe('an order that can no longer be changed', () => {
  const advance = (id: string, expectedStatus: string) => app.inject({ method: 'POST', url: `/kitchen/orders/${id}/advance`, payload: { expectedStatus } });

  it.each([
    ['NOT_STARTED', 'STARTED', 'The kitchen has already started your order, so it can no longer be changed.', 1],
    ['STARTED', 'READY_FOR_PICKUP', 'Your order is ready for pickup, so it can no longer be changed.', 2],
    ['READY_FOR_PICKUP', 'DELIVERED', 'Your order has already been delivered, so it can no longer be changed.', 3],
  ])('is refused once it is past Not Started (%s -> %s), and nothing changes', async (_from, status, message, steps) => {
    const placed = await place(original);
    const walk = ['NOT_STARTED', 'STARTED', 'READY_FOR_PICKUP'];
    for (let i = 0; i < steps; i++) await advance(placed.id, walk[i]!);
    const before = await viewOf(placed.id);

    const { res, body } = await change(placed.id, before.version, next);

    expect(res.statusCode).toBe(409);
    expect(body).toMatchObject({ error: 'order_locked', currentStatus: status, message });
    expect(await viewOf(placed.id)).toEqual(before);
    expect(count('order_revisions')).toBe(1);
  });

  it('a cancelled order cannot be changed, and says why', async () => {
    const placed = await place(original);
    await app.inject({ method: 'POST', url: `/orders/${placed.id}/cancel`, payload: {} });
    const { res, body } = await change(placed.id, placed.version, next);
    expect(res.statusCode).toBe(409);
    expect(body).toMatchObject({ error: 'order_cancelled', message: 'This order has been cancelled, so it can no longer be changed.' });
  });

  it('an unknown order is a 404', async () => {
    const { res } = await change('no-such-order', 1, next);
    expect(res.statusCode).toBe(404);
  });

  it('the page was open while the kitchen started the order: the change is refused with the order\'s real status', async () => {
    const placed = await place(original);
    const { menuToken } = await loadMenu();
    const quote = await quoteOf(menuToken, next);
    await advance(placed.id, 'NOT_STARTED'); // the kitchen starts while the customer is still editing

    const res = await put(placed.id, { menuToken, order: next, claimed: claimedOf(quote), expectedVersion: placed.version });

    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: 'order_locked', currentStatus: 'STARTED' });
    expect((await viewOf(placed.id)).totalCents).toBe(533); // the order they were cooking is the one they ordered
  });

  it('the other way round: a saved change does not stop the kitchen, and the kitchen then cooks the CHANGED order', async () => {
    const placed = await place(original);
    await change(placed.id, placed.version, next);
    const started = await advance(placed.id, 'NOT_STARTED');
    expect(started.statusCode).toBe(200);
    expect(started.json().order.items).toEqual([{ quantity: 2, size: 'Large', toppings: ['Bacon'] }]);
  });
});

describe('a change to the wrong version', () => {
  it('two windows: the second to save is told the order changed, and nothing is overwritten', async () => {
    const placed = await place(original);
    await change(placed.id, placed.version, { lines: [line('large')] }); // window A saves
    const { res, body } = await change(placed.id, placed.version, { lines: [line('medium', 4)] }); // window B still has the old version

    expect(res.statusCode).toBe(409);
    expect(body.error).toBe('order_changed');
    expect(body.order).toMatchObject({ version: placed.version + 1, totalCents: 1278 }); // the latest, for the page to reload
    expect(count('order_revisions')).toBe(2);
  });

  it('a request that does not say which version it is changing is refused', async () => {
    const placed = await place(original);
    const { menuToken } = await loadMenu();
    const res = await put(placed.id, { menuToken, order: original, claimed: { subtotalCents: 500, totalCents: 533 } });
    expect(res.statusCode).toBe(400);
  });
});

describe('a retry never applies a change twice', () => {
  it('the same key and order returns the same result and writes nothing more', async () => {
    const placed = await place(original);
    const key = 'upd-retry-key-1';
    const first = await change(placed.id, placed.version, next, { key });
    const again = await put(placed.id, { menuToken: first.menuToken, order: next, claimed: claimedOf(first.quote), expectedVersion: placed.version }, key);

    expect(first.res.statusCode).toBe(200);
    expect(again.statusCode).toBe(200);
    expect(again.json()).toMatchObject({ replayed: true, order: { totalCents: 2854, version: placed.version + 1 } });
    expect(count('order_revisions')).toBe(2); // original + one change, not two
  });

  it('works even after the order has since been started (the first answer is still the answer)', async () => {
    const placed = await place(original);
    const key = 'upd-retry-key-2';
    const first = await change(placed.id, placed.version, next, { key });
    await app.inject({ method: 'POST', url: `/kitchen/orders/${placed.id}/advance`, payload: { expectedStatus: 'NOT_STARTED' } });

    const again = await put(placed.id, { menuToken: first.menuToken, order: next, claimed: claimedOf(first.quote), expectedVersion: placed.version }, key);
    expect(again.statusCode).toBe(200);
    expect(again.json().replayed).toBe(true);
  });

  it('a key reused for a DIFFERENT change is refused, as is a key from placing, or from another order', async () => {
    const a = await place(original);
    const b = await place(original);
    const key = 'upd-retry-key-3';
    await change(a.id, a.version, next, { key });

    const { menuToken } = await loadMenu();
    const other: Order = { lines: [line('medium')] };
    const otherClaim = claimedOf(await quoteOf(menuToken, other));
    const differentChange = await put(a.id, { menuToken, order: other, claimed: otherClaim, expectedVersion: a.version + 1 }, key);
    const otherOrder = await put(b.id, { menuToken, order: next, claimed: claimedOf(await quoteOf(menuToken, next)), expectedVersion: b.version }, key);

    expect(differentChange.statusCode).toBe(422);
    expect(differentChange.json().error).toBe('idempotency_key_reused');
    expect(otherOrder.statusCode).toBe(422);
  });

  it.each([null, '', 'short', 'bad/char!'])('refuses a missing or malformed key: %j', async (key) => {
    const placed = await place(original);
    const { menuToken } = await loadMenu();
    const res = await put(placed.id, { menuToken, order: next, claimed: { subtotalCents: 1, totalCents: 1 }, expectedVersion: placed.version }, key);
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('idempotency_key_required');
  });
});

describe('a change is held and checked by the same rules as placing an order', () => {
  it('prices that differ from what the page showed: held, with the corrected quote, and nothing is written', async () => {
    const placed = await place(original);
    const { menuToken } = await loadMenu();
    const quote = await quoteOf(menuToken, next);
    const res = await put(placed.id, { menuToken, order: next, claimed: { ...claimedOf(quote), totalCents: 1000 }, expectedVersion: placed.version });

    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: 'confirmation_required', reasons: ['prices_changed'] });
    expect(res.json().quote.totalCents).toBe(2854);
    expect(await viewOf(placed.id)).toMatchObject({ totalCents: 533, version: placed.version, revision: 1 });
  });

  it('then accepting the updated figures (same key) saves it', async () => {
    const placed = await place(original);
    const { menuToken } = await loadMenu();
    const quote = await quoteOf(menuToken, next);
    const key = 'upd-confirm-key-1';
    const held = await put(placed.id, { menuToken, order: next, claimed: { ...claimedOf(quote), totalCents: 1000 }, expectedVersion: placed.version }, key);
    const accepted = await put(placed.id, { menuToken, order: next, claimed: claimedOf(held.json().quote), expectedVersion: placed.version }, key);
    expect(accepted.statusCode).toBe(200);
    expect(accepted.json().order.totalCents).toBe(2854);
  });

  it('a promo that no longer applies holds the change', async () => {
    const placed = await place(original);
    const { menuToken } = await loadMenu();
    const withPromo: Order = { lines: [line('small', 5)], promoCodes: ['SAVE5'] };
    const claimed = claimedOf(await quoteOf(menuToken, withPromo));
    db.exec(`UPDATE promos SET active = 0 WHERE code = 'SAVE5'`);
    const res = await put(placed.id, { menuToken, order: withPromo, claimed, expectedVersion: placed.version });
    expect(res.json()).toMatchObject({ reasons: ['prices_changed', 'promo_removed'], removedPromos: ['SAVE5'] });
  });

  it('a very large tip must be confirmed for that amount', async () => {
    const placed = await place(original);
    const bigTip: Order = { lines: [line('large', 4)], tip: { mode: 'amount', cents: 3000 } };
    expect((await change(placed.id, placed.version, bigTip)).body.reasons).toEqual(['large_tip']);
    const ok = await change(placed.id, placed.version, bigTip, { confirmations: { largeTipCents: 3000 } });
    expect(ok.res.statusCode).toBe(200);
    expect(ok.body.order.totalCents).toBe(5112 + 3000);
  });

  it('bad data: 422 with every problem; an expired session: 409', async () => {
    const placed = await place(original);
    const { menuToken } = await loadMenu();
    const bad = await put(placed.id, {
      menuToken,
      order: { lines: [line('xl', 0, ['mystery'])], tip: { mode: 'amount', cents: -5 } },
      claimed: { subtotalCents: 0, totalCents: 0 },
      expectedVersion: placed.version,
    });
    expect(bad.statusCode).toBe(422);
    expect(bad.json().issues.map((i: { code: string }) => i.code)).toEqual(['invalid_quantity', 'unknown_size', 'unknown_topping', 'invalid_tip']);

    clock = at(30);
    const expired = await put(placed.id, { menuToken, order: next, claimed: { subtotalCents: 1, totalCents: 1 }, expectedVersion: placed.version });
    expect(expired.statusCode).toBe(409);
    expect(expired.json().error).toBe('menu_expired');
    expect((await viewOf(placed.id)).revision).toBe(1);
  });
});

describe('changing is all-or-nothing', () => {
  it('a failure part-way leaves the order exactly as it was, and the retry then works', async () => {
    const placed = await place({ lines: [line('small', 4, ['pepperoni'])], promoCodes: ['SAVE5'] }); // 4 x $5.40 = $21.60: over $20
    const before = await viewOf(placed.id);
    const { menuToken } = await loadMenu();
    const quote = await quoteOf(menuToken, next);
    const body = { menuToken, order: next, claimed: claimedOf(quote), expectedVersion: placed.version };

    db.exec(`CREATE TRIGGER boom BEFORE INSERT ON order_revisions WHEN NEW.revision = 2 BEGIN SELECT RAISE(ABORT, 'boom'); END`);
    const failed = await put(placed.id, body, 'upd-atomic-key-1');
    expect(failed.statusCode).toBe(500);
    expect(await viewOf(placed.id)).toEqual(before); // old lines, old promos, old totals, old version

    db.exec(`DROP TRIGGER boom`);
    const retried = await put(placed.id, body, 'upd-atomic-key-1');
    expect(retried.statusCode).toBe(200);
    expect(retried.json().order.totalCents).toBe(2854);
  });
});

describe('snapshots that earlier versions used are kept', () => {
  it('a menu session an old revision was priced on is not cleaned up while the revision exists', async () => {
    const placed = await place(original);
    const firstToken = (db.prepare(`SELECT menu_snapshot_token t FROM orders WHERE id = ?`).get(placed.id) as { t: string }).t;
    clock = at(10);
    await change(placed.id, placed.version, next); // the order now points at a newer snapshot

    purgeExpiredSnapshots(db, new Date('2030-01-01T00:00:00.000Z')); // long after everything expired

    const remaining = (db.prepare(`SELECT token FROM menu_snapshots`).all() as { token: string }[]).map((r) => r.token);
    expect(remaining).toContain(firstToken); // referenced by revision 1
  });
});

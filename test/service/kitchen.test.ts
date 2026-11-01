import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { DatabaseSync } from 'node:sqlite';
import { buildApp } from '../../src/service/app.js';
import { openDatabase } from '../../src/service/db.js';
import { insertOrder } from '../helpers/orders.js';

let db: DatabaseSync;
let app: FastifyInstance;
const FIXED = new Date('2026-03-01T13:00:00.000Z');

beforeEach(() => {
  db = openDatabase({ path: ':memory:', seed: true });
  app = buildApp({ db, now: () => FIXED });
});
afterEach(async () => {
  await app.close();
  db.close();
});

const advance = (id: string, expectedStatus: string) =>
  app.inject({ method: 'POST', url: `/kitchen/orders/${id}/advance`, payload: { expectedStatus } });
const cancel = (id: string, payload?: object) =>
  app.inject({ method: 'POST', url: `/kitchen/orders/${id}/cancel`, payload: payload ?? {} });
const list = async (query = '') => (await app.inject({ method: 'GET', url: `/kitchen/orders${query}` })).json().orders;
const events = (id: string) =>
  db.prepare(`SELECT from_status, to_status, actor, at FROM order_status_events WHERE order_id = ? ORDER BY id`).all(id);

describe('GET /kitchen/orders', () => {
  it('lists newest first with received time, items and toppings', async () => {
    const older = insertOrder(db, { createdAt: '2026-03-01T11:00:00.000Z', lines: [{ size: 'small', quantity: 2 }] });
    const newer = insertOrder(db, {
      createdAt: '2026-03-01T12:30:00.000Z',
      lines: [{ size: 'large', quantity: 1, toppings: ['pepperoni', 'bacon'] }],
    });

    const orders = await list();

    expect(orders.map((o: { id: string }) => o.id)).toEqual([newer, older]);
    expect(orders[0]).toMatchObject({
      status: 'NOT_STARTED',
      createdAt: '2026-03-01T12:30:00.000Z',
      items: [{ quantity: 1, size: 'Large', toppings: ['Pepperoni', 'Bacon'] }],
      nextStatus: 'STARTED',
      canCancel: true,
    });
  });

  it('hides delivered and cancelled orders unless asked', async () => {
    const open = insertOrder(db, { status: 'STARTED' });
    insertOrder(db, { status: 'DELIVERED' });
    insertOrder(db, { status: 'CANCELLED' });

    expect((await list()).map((o: { id: string }) => o.id)).toEqual([open]);
    expect(await list('?include=closed')).toHaveLength(3);
  });

  it('tells the UI what each status allows, so the UI needs no rules', async () => {
    for (const status of ['NOT_STARTED', 'STARTED', 'READY_FOR_PICKUP', 'DELIVERED', 'CANCELLED']) insertOrder(db, { status });
    const byStatus = Object.fromEntries((await list('?include=closed')).map((o: { status: string }) => [o.status, o]));

    expect(byStatus.NOT_STARTED).toMatchObject({ nextStatus: 'STARTED', canCancel: true });
    expect(byStatus.STARTED).toMatchObject({ nextStatus: 'READY_FOR_PICKUP', canCancel: true }); // kitchen may cancel
    expect(byStatus.READY_FOR_PICKUP).toMatchObject({ nextStatus: 'DELIVERED', canCancel: true });
    expect(byStatus.DELIVERED).toMatchObject({ nextStatus: null, canCancel: false });
    expect(byStatus.CANCELLED).toMatchObject({ nextStatus: null, canCancel: false });
  });
});

describe('advancing', () => {
  it('moves an order through every status, recording each step', async () => {
    const id = insertOrder(db);

    for (const [from, to] of [
      ['NOT_STARTED', 'STARTED'],
      ['STARTED', 'READY_FOR_PICKUP'],
      ['READY_FOR_PICKUP', 'DELIVERED'],
    ]) {
      const res = await advance(id, from!);
      expect(res.statusCode).toBe(200);
      expect(res.json().order.status).toBe(to);
    }

    expect(events(id)).toEqual([
      { from_status: 'NOT_STARTED', to_status: 'STARTED', actor: 'kitchen', at: FIXED.toISOString() },
      { from_status: 'STARTED', to_status: 'READY_FOR_PICKUP', actor: 'kitchen', at: FIXED.toISOString() },
      { from_status: 'READY_FOR_PICKUP', to_status: 'DELIVERED', actor: 'kitchen', at: FIXED.toISOString() },
    ]);
  });

  it('a double-click advances once: the stale second request is refused, not applied', async () => {
    const id = insertOrder(db);

    const first = await advance(id, 'NOT_STARTED');
    const second = await advance(id, 'NOT_STARTED'); // screen still thought it was NOT_STARTED

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(409);
    expect(second.json()).toMatchObject({ error: 'status_changed', currentStatus: 'STARTED' });
    expect((await list())[0].status).toBe('STARTED'); // not READY_FOR_PICKUP
    expect(events(id)).toHaveLength(1);
  });

  it('trying to advance an order the customer has cancelled says so', async () => {
    const id = insertOrder(db);
    // The kitchen screen still shows NOT_STARTED; meanwhile the customer cancels.
    await app.inject({ method: 'POST', url: `/orders/${id}/cancel`, payload: { reason: 'changed my mind' } });

    const res = await advance(id, 'NOT_STARTED');

    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: 'order_cancelled', message: 'Order has been cancelled', currentStatus: 'CANCELLED' });
    expect((await list('?include=closed'))[0]).toMatchObject({ status: 'CANCELLED', cancellationReason: 'changed my mind' });
  });

  it('refuses to advance a delivered order', async () => {
    const id = insertOrder(db, { status: 'DELIVERED' });
    const res = await advance(id, 'DELIVERED');
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: 'not_allowed', currentStatus: 'DELIVERED' });
  });

  it('bumps the version and updated_at on every change', async () => {
    const id = insertOrder(db);
    const res = await advance(id, 'NOT_STARTED');
    expect(res.json().order).toMatchObject({ version: 2, updatedAt: FIXED.toISOString() });
  });

  it('404s an unknown order and 400s a malformed request', async () => {
    expect((await advance('does-not-exist', 'NOT_STARTED')).statusCode).toBe(404);
    const id = insertOrder(db);
    expect((await advance(id, 'BOGUS')).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: `/kitchen/orders/${id}/advance`, payload: {} })).statusCode).toBe(400);
  });
});

describe('kitchen cancelling', () => {
  it('cancels a Not Started order and stores the trimmed reason', async () => {
    const id = insertOrder(db);
    const res = await cancel(id, { reason: '  Out of dough  ' });

    expect(res.statusCode).toBe(200);
    expect(res.json().order).toMatchObject({ status: 'CANCELLED', cancellationReason: 'Out of dough', nextStatus: null, canCancel: false });
    expect(events(id)).toEqual([{ from_status: 'NOT_STARTED', to_status: 'CANCELLED', actor: 'kitchen', at: FIXED.toISOString() }]);
  });

  it.each(['STARTED', 'READY_FOR_PICKUP'])('can cancel at any time: also when the order is %s', async (status) => {
    const id = insertOrder(db, { status });
    const res = await cancel(id, { reason: 'Burnt' });
    expect(res.statusCode).toBe(200);
    expect(res.json().order.status).toBe('CANCELLED');
    expect(events(id)).toEqual([{ from_status: status, to_status: 'CANCELLED', actor: 'kitchen', at: FIXED.toISOString() }]);
  });

  it('but not once it has been delivered', async () => {
    const id = insertOrder(db, { status: 'DELIVERED' });
    const res = await cancel(id);
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: 'not_allowed', currentStatus: 'DELIVERED' });
  });

  it('refuses when the screen was stale (expectedStatus no longer matches)', async () => {
    const id = insertOrder(db, { status: 'STARTED' });
    const res = await cancel(id, { expectedStatus: 'NOT_STARTED' });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: 'status_changed', currentStatus: 'STARTED' });
  });

  it('the reason is optional; blank or missing means none', async () => {
    const a = insertOrder(db);
    const b = insertOrder(db);
    expect((await cancel(a)).json().order.cancellationReason).toBeNull();
    expect((await cancel(b, { reason: '   ' })).json().order.cancellationReason).toBeNull();
  });

  it('rejects a reason over 200 characters', async () => {
    const id = insertOrder(db);
    expect((await cancel(id, { reason: 'x'.repeat(201) })).statusCode).toBe(400);
    expect((await cancel(id, { reason: 'x'.repeat(200) })).statusCode).toBe(200);
  });

  it('is idempotent: cancelling again succeeds and keeps the first reason', async () => {
    const id = insertOrder(db);
    await cancel(id, { reason: 'first' });
    const retry = await cancel(id, { reason: 'second' });

    expect(retry.statusCode).toBe(200);
    expect(retry.json().order).toMatchObject({ status: 'CANCELLED', cancellationReason: 'first' });
    expect(events(id)).toHaveLength(1);
  });

  it('404s an unknown order', async () => {
    expect((await cancel('does-not-exist')).statusCode).toBe(404);
  });

  it('the database refuses a reason on an order that is not cancelled', () => {
    const id = insertOrder(db);
    expect(() => db.prepare(`UPDATE orders SET cancellation_reason = 'sneaky' WHERE id = ?`).run(id)).toThrow(/CHECK/i);
  });

  it('a failure inside the transaction leaves the order untouched', async () => {
    const id = insertOrder(db);
    // Make the audit-log insert fail, after the status UPDATE has already run.
    db.exec(`CREATE TRIGGER boom BEFORE INSERT ON order_status_events BEGIN SELECT RAISE(ABORT, 'boom'); END`);

    const res = await advance(id, 'NOT_STARTED');

    expect(res.statusCode).toBe(500);
    expect((db.prepare(`SELECT status FROM orders WHERE id = ?`).get(id) as { status: string }).status).toBe('NOT_STARTED');
  });
});

describe('kitchen page', () => {
  it('serves the page and its script', async () => {
    const page = await app.inject({ method: 'GET', url: '/kitchen' });
    expect(page.statusCode).toBe(200);
    expect(page.headers['content-type']).toMatch(/text\/html/);
    expect(page.body).toContain('Kitchen orders');
    expect(page.body).toContain('/kitchen/kitchen.js');

    const js = await app.inject({ method: 'GET', url: '/kitchen/kitchen.js' });
    expect(js.statusCode).toBe(200);
    expect(js.headers['content-type']).toMatch(/javascript/);
  });
});

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

const get = (id: string) => app.inject({ method: 'GET', url: `/orders/${id}` });
const cancel = (id: string, payload?: object) =>
  app.inject({ method: 'POST', url: `/orders/${id}/cancel`, payload: payload ?? {} });
const kitchenAdvance = (id: string, expectedStatus: string) =>
  app.inject({ method: 'POST', url: `/kitchen/orders/${id}/advance`, payload: { expectedStatus } });
const events = (id: string) => db.prepare(`SELECT from_status, to_status, actor FROM order_status_events WHERE order_id = ? ORDER BY id`).all(id);

describe('GET /orders/:id (status check)', () => {
  it('returns the status and contents, without kitchen-only fields', async () => {
    const id = insertOrder(db, { lines: [{ size: 'medium', quantity: 2, toppings: ['onions'] }] });
    const res = await get(id);

    expect(res.statusCode).toBe(200);
    const { order } = res.json();
    expect(order).toMatchObject({
      id,
      status: 'NOT_STARTED',
      items: [{ quantity: 2, size: 'Medium', toppings: ['Onions'] }],
      canCancel: true,
    });
    expect(order).not.toHaveProperty('nextStatus');
  });

  it('reflects the kitchen moving the order along, and what the customer may still do', async () => {
    const id = insertOrder(db);
    expect((await get(id)).json().order.canCancel).toBe(true);

    await kitchenAdvance(id, 'NOT_STARTED');

    expect((await get(id)).json().order).toMatchObject({ status: 'STARTED', canCancel: false });
  });

  it('404s an unknown order', async () => {
    const res = await get('nope');
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe('not_found');
  });
});

describe('customer cancel', () => {
  it('cancels a Not Started order, records who did it, and stores the reason', async () => {
    const id = insertOrder(db);
    const res = await cancel(id, { reason: 'Ordered by mistake', expectedStatus: 'NOT_STARTED' });

    expect(res.statusCode).toBe(200);
    expect(res.json().order).toMatchObject({ status: 'CANCELLED', cancellationReason: 'Ordered by mistake', canCancel: false });
    expect(events(id)).toEqual([{ from_status: 'NOT_STARTED', to_status: 'CANCELLED', actor: 'customer' }]);
  });

  it.each(['STARTED', 'READY_FOR_PICKUP', 'DELIVERED'])('is refused once the order is %s', async (status) => {
    const id = insertOrder(db, { status });
    const res = await cancel(id);

    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: 'not_allowed', currentStatus: status });
    expect(events(id)).toEqual([]);
    expect((await get(id)).json().order.status).toBe(status); // unchanged
  });

  describe('the API double-checks the status at the moment of the request', () => {
    it('the page saw Not Started, but the kitchen started the order a moment before: refused', async () => {
      const id = insertOrder(db);
      // 1. The customer's page loads and shows NOT_STARTED with a Cancel button.
      expect((await get(id)).json().order.status).toBe('NOT_STARTED');
      // 2. The kitchen starts the order.
      await kitchenAdvance(id, 'NOT_STARTED');
      // 3. The customer presses Cancel on the stale page.
      const res = await cancel(id, { expectedStatus: 'NOT_STARTED', reason: 'too slow' });

      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({ error: 'status_changed', currentStatus: 'STARTED' });
      expect(res.json().message).toMatch(/changed since you last checked/i);
      expect((await get(id)).json().order).toMatchObject({ status: 'STARTED', cancellationReason: null });
    });

    it('is enforced even if the client sends no expected status', async () => {
      const id = insertOrder(db);
      await kitchenAdvance(id, 'NOT_STARTED');
      expect((await cancel(id)).statusCode).toBe(409);
    });

    it('the other way round: cancel first, then the kitchen is told the order was cancelled', async () => {
      const id = insertOrder(db);
      expect((await cancel(id, { expectedStatus: 'NOT_STARTED' })).statusCode).toBe(200);

      const res = await kitchenAdvance(id, 'NOT_STARTED');

      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({ error: 'order_cancelled', message: 'Order has been cancelled' });
      expect((await get(id)).json().order.status).toBe('CANCELLED');
    });
  });

  it('is idempotent, so a retry after a timeout is safe and keeps the first reason', async () => {
    const id = insertOrder(db);
    const first = await cancel(id, { reason: 'first', expectedStatus: 'NOT_STARTED' });
    const retry = await cancel(id, { reason: 'second', expectedStatus: 'NOT_STARTED' });

    expect(first.statusCode).toBe(200);
    expect(retry.statusCode).toBe(200);
    expect(retry.json().order).toMatchObject({ status: 'CANCELLED', cancellationReason: 'first' });
    expect(events(id)).toHaveLength(1);
  });

  it('404s an unknown order and 400s a bad request', async () => {
    expect((await cancel('nope')).statusCode).toBe(404);
    const id = insertOrder(db);
    expect((await cancel(id, { expectedStatus: 'BOGUS' })).statusCode).toBe(400);
    expect((await cancel(id, { reason: 'x'.repeat(201) })).statusCode).toBe(400);
  });
});

describe('status page', () => {
  it('serves the same page for any order id, and its script', async () => {
    const page = await app.inject({ method: 'GET', url: '/track/some-order-id' });
    expect(page.statusCode).toBe(200);
    expect(page.headers['content-type']).toMatch(/text\/html/);
    expect(page.body).toContain('Your order');
    expect(page.body).toContain('/track.js');

    const js = await app.inject({ method: 'GET', url: '/track.js' });
    expect(js.statusCode).toBe(200);
    expect(js.headers['content-type']).toMatch(/javascript/);
  });
});

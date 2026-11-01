import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildBuilderApp } from '../../src/builder/app.js';
import { loadBuilderConfig } from '../../src/builder/config.js';
import { buildApp } from '../../src/service/app.js';
import { openDatabase } from '../../src/service/db.js';

const open: FastifyInstance[] = [];
const track = <T extends FastifyInstance>(app: T) => (open.push(app), app);
afterEach(async () => {
  await Promise.all(open.splice(0).map((a) => a.close()));
});

describe('builder talking to a real order service over HTTP', () => {
  async function startBoth() {
    const db = openDatabase({ path: ':memory:', seed: true });
    const service = track(buildApp({ db, now: () => new Date('2026-06-15T12:00:00.000Z') }));
    await service.listen({ host: '127.0.0.1', port: 0 });
    const url = `http://127.0.0.1:${(service.server.address() as AddressInfo).port}`;
    return { builder: track(buildBuilderApp({ orderServiceUrl: url })), url, db };
  }

  it('relays GET /api/menu to the order service', async () => {
    const { builder } = await startBoth();
    const res = await builder.inject({ method: 'GET', url: '/api/menu' });

    expect(res.statusCode).toBe(200);
    expect(res.json().menu.name).toBe('Standard Menu');
    expect(res.json().sizes).toHaveLength(3);
  });

  it("passes the order service's errors through unchanged (status and body)", async () => {
    const { builder } = await startBoth();
    const res = await builder.inject({ method: 'GET', url: '/api/orders/does-not-exist' });

    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe('not_found');
  });

  it('relays POST bodies (here, a customer cancel on a missing order)', async () => {
    const { builder } = await startBoth();
    const res = await builder.inject({
      method: 'POST',
      url: '/api/orders/nope/cancel',
      payload: { reason: 'changed my mind' },
    });
    expect(res.statusCode).toBe(404);
  });
});

describe('the order status page is reachable through the builder (one origin for the browser)', () => {
  async function startBoth() {
    const db = openDatabase({ path: ':memory:', seed: true });
    const service = track(buildApp({ db, now: () => new Date('2026-06-15T12:00:00.000Z') }));
    await service.listen({ host: '127.0.0.1', port: 0 });
    const url = `http://127.0.0.1:${(service.server.address() as AddressInfo).port}`;
    return { builder: track(buildBuilderApp({ orderServiceUrl: url })), db };
  }

  it('relays the status page and its script', async () => {
    const { builder } = await startBoth();
    const page = await builder.inject({ method: 'GET', url: '/track/some-order-id' });
    expect(page.statusCode).toBe(200);
    expect(page.headers['content-type']).toMatch(/text\/html/);
    expect(page.body).toContain('Your order');
    expect((await builder.inject({ method: 'GET', url: '/track.js' })).headers['content-type']).toMatch(/javascript/);
  });

  it('places an order through /api/orders and then the status page can read and cancel it, all via the builder', async () => {
    const { builder } = await startBoth();
    const menu = (await builder.inject({ method: 'GET', url: '/api/menu' })).json();
    const order = { lines: [{ size: 'small', quantity: 1, toppings: [] }] };
    const quote = (await builder.inject({ method: 'POST', url: '/api/quote', payload: { menuToken: menu.menuToken, order } })).json().quote;

    const placed = await builder.inject({
      method: 'POST',
      url: '/api/orders',
      headers: { 'idempotency-key': 'relay-test-key-1' },
      payload: { menuToken: menu.menuToken, order, claimed: { subtotalCents: quote.subtotalCents, totalCents: quote.totalCents } },
    });
    expect(placed.statusCode).toBe(201);
    const { id } = placed.json().order;
    expect(placed.json().trackPath).toBe(`/track/${id}`);

    // The status page (served at the builder's own origin) asks the builder, which asks the service.
    const status = await builder.inject({ method: 'GET', url: `/orders/${id}` });
    expect(status.json().order).toMatchObject({ id, status: 'NOT_STARTED', totalCents: 533 });
    const cancelled = await builder.inject({ method: 'POST', url: `/orders/${id}/cancel`, payload: { expectedStatus: 'NOT_STARTED' } });
    expect(cancelled.json().order.status).toBe('CANCELLED');
  });

  it('the Idempotency-Key is forwarded, so a retry through the builder still places the order once', async () => {
    const { builder, db } = await startBoth();
    const menu = (await builder.inject({ method: 'GET', url: '/api/menu' })).json();
    const order = { lines: [{ size: 'small', quantity: 1, toppings: [] }] };
    const body = { menuToken: menu.menuToken, order, claimed: { subtotalCents: 500, totalCents: 533 } };
    const send = () => builder.inject({ method: 'POST', url: '/api/orders', headers: { 'idempotency-key': 'relay-test-key-2' }, payload: body });

    const [first, second] = [await send(), await send()];

    expect([first.statusCode, second.statusCode]).toEqual([201, 200]);
    expect(second.json().order.id).toBe(first.json().order.id);
    expect((db.prepare(`SELECT COUNT(*) n FROM orders`).get() as { n: number }).n).toBe(1);
  });

  it('does NOT relay the kitchen screen or its actions', async () => {
    const { builder } = await startBoth();
    for (const url of ['/kitchen', '/kitchen/orders', '/menu', '/quote']) {
      expect((await builder.inject({ method: 'GET', url })).statusCode, url).toBe(404);
    }
    expect((await builder.inject({ method: 'POST', url: '/kitchen/orders/x/advance', payload: {} })).statusCode).toBe(404);
  });
});

describe('builder when the order service misbehaves', () => {
  const build = (fetchImpl: typeof fetch, timeoutMs?: number) =>
    track(buildBuilderApp({ orderServiceUrl: 'http://order-service.invalid', fetchImpl, timeoutMs }));

  it('answers 502 when the order service is unreachable', async () => {
    const app = build(async () => {
      throw new TypeError('fetch failed');
    });
    const res = await app.inject({ method: 'GET', url: '/api/menu' });

    expect(res.statusCode).toBe(502);
    expect(res.json()).toMatchObject({ error: 'order_service_unavailable' });
  });

  it('answers 504 when the order service is too slow', async () => {
    // A fetch that never answers until its abort signal fires, like a hung connection.
    const hung = ((_url: unknown, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal!.reason));
      })) as typeof fetch;
    const app = build(hung, 50);

    const res = await app.inject({ method: 'GET', url: '/api/menu' });

    expect(res.statusCode).toBe(504);
    expect(res.json()).toMatchObject({ error: 'order_service_timeout' });
  });

  it('forwards only the headers it means to (content-type, idempotency-key)', async () => {
    let seen: Record<string, string> = {};
    const app = build((async (_url: unknown, init?: RequestInit) => {
      seen = init?.headers as Record<string, string>;
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch);

    await app.inject({
      method: 'POST',
      url: '/api/orders',
      headers: { 'content-type': 'application/json', 'idempotency-key': 'abc-123', cookie: 'secret=1', 'x-other': 'no' },
      payload: { a: 1 },
    });

    expect(seen).toEqual({ 'content-type': 'application/json', 'idempotency-key': 'abc-123' });
  });

  it('keeps the path and query string when relaying', async () => {
    let url = '';
    const app = build((async (u: unknown) => {
      url = String(u);
      return new Response('{}', { status: 200 });
    }) as typeof fetch);

    await app.inject({ method: 'GET', url: '/api/orders/123?x=1&y=2' });

    expect(url).toBe('http://order-service.invalid/orders/123?x=1&y=2');
  });
});

describe('builder pages and config', () => {
  it('serves its own page and script, and a health check', async () => {
    const app = track(buildBuilderApp({ orderServiceUrl: 'http://x.invalid' }));
    const page = await app.inject({ method: 'GET', url: '/' });
    expect(page.statusCode).toBe(200);
    expect(page.headers['content-type']).toMatch(/text\/html/);
    for (const file of ['/app.js', '/logic.js']) {
      const res = await app.inject({ method: 'GET', url: file });
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toMatch(/javascript/);
    }
    expect(page.body).toContain('type="module"');

    // Changing an order has its own address, which serves the same page; the page reads the order id from it.
    const change = await app.inject({ method: 'GET', url: '/change/38fed217-2ab0-4fb9-9203-e2a1db0e32ea' });
    expect(change.statusCode).toBe(200);
    expect(change.headers['content-type']).toMatch(/text\/html/);
    expect(change.body).toContain('Your order right now');
    expect(change.headers['cache-control']).toMatch(/no-cache/); // pages are never served stale
    expect((await app.inject({ method: 'GET', url: '/health' })).json()).toEqual({ status: 'ok' });
  });

  it('defaults to port 3000 and the order service on 3001, without a trailing slash', () => {
    expect(loadBuilderConfig({})).toMatchObject({ host: '127.0.0.1', port: 3000, orderServiceUrl: 'http://127.0.0.1:3001' });
    expect(loadBuilderConfig({ ORDER_SERVICE_URL: 'http://svc:3001///' }).orderServiceUrl).toBe('http://svc:3001');
  });

  it('uses BUILDER_PORT, so it never collides with the service PORT', () => {
    expect(loadBuilderConfig({ PORT: '3001', BUILDER_PORT: '3000' }).port).toBe(3000);
    expect(() => loadBuilderConfig({ BUILDER_PORT: 'x' })).toThrow(/BUILDER_PORT/);
  });
});

import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { DatabaseSync } from 'node:sqlite';
import { buildApp } from '../../src/service/app.js';
import { openDatabase } from '../../src/service/db.js';
// @ts-expect-error - a plain JavaScript command-line script, imported so what it does can be tested
import { seedOrders, SEED_ORDERS } from '../../scripts/seed-orders.mjs';

// The sample orders were entered by hand through the app and then captured as a script. They are part of
// how the project is demonstrated, so they are tested: the script must keep working as the service changes,
// and what it leaves behind must be exactly what was entered, down to the cent.

interface Result { name: string; id: string; status: string; totalCents: number; revision: number }
interface Outcome { skipped: boolean; existing: number; results: Result[] }
interface Spec { name: string; about: string; expectedTotalCents: number; expectedOriginalTotalCents?: number; order: { lines: { size: string; toppings: string[] }[]; promoCodes?: string[] }; change?: Spec['order']; target?: string; advanceTo?: string; cancel?: { by: string; reason?: string } }

let db: DatabaseSync;
let app: FastifyInstance;
let url: string;

async function start(seed = true) {
  db = openDatabase({ path: ':memory:', seed });
  app = buildApp({ db, now: () => new Date('2026-06-15T12:00:00.000Z') });
  await app.listen({ host: '127.0.0.1', port: 0 });
  url = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
}
beforeEach(() => start());
afterEach(async () => {
  await app.close();
  db.close();
});

const specs = SEED_ORDERS as Spec[];
const run = (opts: object = {}) => seedOrders({ serviceUrl: url, ...opts }) as Promise<Outcome>;
const view = async (id: string) => (await (await fetch(`${url}/orders/${id}`)).json()).order;
const history = (id: string) =>
  db.prepare(`SELECT from_status f, to_status t, actor a FROM order_status_events WHERE order_id = ? ORDER BY id`).all(id);

describe('the seed orders', () => {
  it('places every sample order and leaves each in the state it describes', async () => {
    const out = await run();

    expect(out.skipped).toBe(false);
    expect(out.results).toHaveLength(specs.length);
    const byStatus: Record<string, number> = {};
    for (const r of out.results) byStatus[r.status] = (byStatus[r.status] ?? 0) + 1;
    expect(byStatus).toEqual({ DELIVERED: 3, CANCELLED: 3, STARTED: 1, READY_FOR_PICKUP: 1, NOT_STARTED: 1 });
  });

  it('reproduces the orders that were entered by hand to the cent', async () => {
    const out = await run();
    for (const spec of specs) {
      const result = out.results.find((r) => r.name === spec.name)!;
      expect(result.totalCents, `${spec.name}: current total`).toBe(spec.expectedTotalCents);
      if (spec.expectedOriginalTotalCents !== undefined) {
        expect((await view(result.id)).original.totalCents, `${spec.name}: as first placed`).toBe(spec.expectedOriginalTotalCents);
      }
    }
  });

  it('covers the things worth demonstrating: both promos, both tip kinds, a change, a very large tip, and cancels by both actors at different stages', async () => {
    const out = await run();
    const order = async (name: string) => view(out.results.find((r) => r.name === name)!.id);
    const events = (name: string) => history(out.results.find((r) => r.name === name)!.id);

    expect((await order('delivered-with-promo')).pricing).toMatchObject({ promos: [{ code: 'ILOVEPIZZA' }], tip: { mode: 'percent', input: 2000 } });
    expect((await order('delivered-save5')).pricing.promos).toEqual([{ code: 'SAVE5', discountCents: 500 }]);
    expect((await order('started-with-promo')).pricing.tip).toMatchObject({ mode: 'amount', input: 1500, cents: 1500 });
    expect((await order('delivered-large-tip')).pricing.tip).toMatchObject({ mode: 'percent', input: 7500 }); // 75%: the script confirmed it, as a customer would

    // Changed once, then cancelled by the customer (no reason given).
    expect(await order('changed-then-cancelled')).toMatchObject({ status: 'CANCELLED', revision: 2, cancellationReason: null });
    expect(await events('changed-then-cancelled')).toEqual([
      { f: null, t: 'NOT_STARTED', a: 'customer' },
      { f: 'NOT_STARTED', t: 'CANCELLED', a: 'customer' },
    ]);

    // Cancelled by the kitchen before it started, and again when it was ready for pickup.
    expect(await order('kitchen-cancelled-early')).toMatchObject({ status: 'CANCELLED', cancellationReason: 'Out of ....' });
    expect((await events('kitchen-cancelled-early')).at(-1)).toEqual({ f: 'NOT_STARTED', t: 'CANCELLED', a: 'kitchen' });
    expect(await order('kitchen-cancelled-when-ready')).toMatchObject({ status: 'CANCELLED', cancellationReason: 'Delivery service no longer around' });
    expect((await events('kitchen-cancelled-when-ready')).at(-1)).toEqual({ f: 'READY_FOR_PICKUP', t: 'CANCELLED', a: 'kitchen' });
  });

  it('what it leaves is what the service itself would have charged: every total adds up', async () => {
    const out = await run();
    for (const r of out.results) {
      const o = await view(r.id);
      const p = o.pricing;
      expect(o.totalCents, r.name).toBe(p.subtotalCents - p.discountCents + p.taxCents + p.tip.cents);
      expect(o.lines.reduce((s: number, l: { lineTotalCents: number }) => s + l.lineTotalCents, 0), r.name).toBe(p.subtotalCents);
    }
  });

  it('records who did what: the history shows the customer placing it and the kitchen moving it on', async () => {
    const out = await run();
    const delivered = out.results.find((r) => r.name === 'delivered-with-promo')!;
    expect(history(delivered.id)).toEqual([
      { f: null, t: 'NOT_STARTED', a: 'customer' },
      { f: 'NOT_STARTED', t: 'STARTED', a: 'kitchen' },
      { f: 'STARTED', t: 'READY_FOR_PICKUP', a: 'kitchen' },
      { f: 'READY_FOR_PICKUP', t: 'DELIVERED', a: 'kitchen' },
    ]);
  });
});

describe('running it again', () => {
  it('refuses to pile sample orders on top of existing ones, and changes nothing', async () => {
    await run();
    const second = await run();
    expect(second).toMatchObject({ skipped: true, existing: specs.length, results: [] });
    expect((db.prepare(`SELECT COUNT(*) n FROM orders`).get() as { n: number }).n).toBe(specs.length);
  });

  it('adds a second set when asked to', async () => {
    await run();
    const again = await run({ add: true });
    expect(again.skipped).toBe(false);
    expect((db.prepare(`SELECT COUNT(*) n FROM orders`).get() as { n: number }).n).toBe(specs.length * 2);
  });

  it('refuses to seed over orders that were placed some other way', async () => {
    const menu = (await (await fetch(`${url}/menu`)).json());
    const order = { lines: [{ size: 'small', quantity: 1, toppings: [] }] };
    const q = (await (await fetch(`${url}/quote`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ menuToken: menu.menuToken, order }) })).json()).quote;
    await fetch(`${url}/orders`, { method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': 'someone-elses-order' }, body: JSON.stringify({ menuToken: menu.menuToken, order, claimed: { subtotalCents: q.subtotalCents, totalCents: q.totalCents } }) });

    expect(await run()).toMatchObject({ skipped: true, existing: 1 });
  });
});

describe('when something is wrong, it says so plainly', () => {
  it('names the problem and the fix if the order service is not running', async () => {
    await expect(seedOrders({ serviceUrl: 'http://127.0.0.1:1' })).rejects.toThrow(/Cannot reach the order service at http:\/\/127\.0\.0\.1:1.*npm run dev/);
  });

  it('says what to do if the database has no menu', async () => {
    await app.close();
    db.close();
    await start(false); // no seed data: no menu
    await expect(run()).rejects.toThrow(/Loading the menu.*SEED_DB=true/);
  });
});

describe('the sample orders themselves', () => {
  it('use only sizes, toppings and promo codes that exist in the seeded menu', async () => {
    const menu = await (await fetch(`${url}/menu`)).json();
    const sizes = new Set(menu.sizes.map((s: { code: string }) => s.code));
    const toppings = new Set(menu.toppings.map((t: { code: string }) => t.code));
    const promos = new Set((db.prepare(`SELECT code FROM promos`).all() as { code: string }[]).map((p) => p.code));
    for (const spec of specs) {
      for (const o of [spec.order, spec.change].filter(Boolean) as Spec['order'][]) {
        for (const l of o.lines) {
          expect(sizes.has(l.size), `${spec.name}: size ${l.size}`).toBe(true);
          for (const t of l.toppings) expect(toppings.has(t), `${spec.name}: topping ${t}`).toBe(true);
        }
        for (const code of o.promoCodes ?? []) expect(promos.has(code), `${spec.name}: promo ${code}`).toBe(true);
      }
    }
  });

  it('have unique names, a description, a recorded total, and a way to end up somewhere', () => {
    const names = specs.map((s) => s.name);
    expect(new Set(names).size).toBe(names.length);
    for (const s of specs) {
      expect(s.about.length, s.name).toBeGreaterThan(10);
      expect(Number.isInteger(s.expectedTotalCents), s.name).toBe(true);
      expect(Boolean(s.target || s.advanceTo || s.cancel), s.name).toBe(true);
    }
  });
});

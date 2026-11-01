import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { DatabaseSync } from 'node:sqlite';
import { buildApp } from '../../src/service/app.js';
import { openDatabase } from '../../src/service/db.js';
import { findSnapshot, getOrCreateSnapshot, purgeExpiredSnapshots } from '../../src/service/menu/snapshots.js';
import { insertOrder } from '../helpers/orders.js';

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

const getMenu = async () => (await app.inject({ method: 'GET', url: '/menu' })).json();
const setLarge = (cents: number) => {
  // Retire the current large price and start a new one now, the way a real price change is made.
  const id = (db.prepare(`SELECT id FROM menu_items WHERE code = 'large'`).get() as { id: number }).id;
  const when = clock.toISOString();
  db.prepare(`UPDATE prices SET effective_to = ? WHERE menu_item_id = ? AND effective_to IS NULL`).run(when, id);
  db.prepare(`INSERT INTO prices (menu_item_id, price_type, amount, effective_from) VALUES (?, 'static', ?, ?)`).run(id, cents, when);
};

describe('the expiry is a database setting', () => {
  it('is seeded by the schema itself, so a fresh database always has it', () => {
    const bare = openDatabase({ path: ':memory:' }); // no seed data
    expect(bare.prepare(`SELECT value FROM settings WHERE key = 'user_menu_expiry_seconds'`).get()).toEqual({ value: 1800 });
    bare.close();
  });

  it('GET /menu gives a token, the deadline (30 minutes by default) and the server clock', async () => {
    const body = await getMenu();
    expect(body.menuToken).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(body.serverTime).toBe(T0.toISOString());
    expect(body.expiresAt).toBe(at(30).toISOString());
  });

  it('changing the setting changes the next deadline, with no deploy', async () => {
    db.prepare(`UPDATE settings SET value = 600 WHERE key = 'user_menu_expiry_seconds'`).run();
    expect((await getMenu()).expiresAt).toBe(at(10).toISOString());
  });

  it.each([
    ['missing', () => db.exec(`DELETE FROM settings WHERE key = 'user_menu_expiry_seconds'`)],
    ['too small (under a minute)', () => db.exec(`UPDATE settings SET value = 30 WHERE key = 'user_menu_expiry_seconds'`)],
    ['absurdly large (over a day)', () => db.exec(`UPDATE settings SET value = 999999 WHERE key = 'user_menu_expiry_seconds'`)],
  ])('refuses to serve a menu when the setting is %s, rather than guess', async (_label, breakIt) => {
    breakIt();
    const res = await app.inject({ method: 'GET', url: '/menu' });
    expect(res.statusCode).toBe(503);
    expect(res.json().error).toBe('menu_misconfigured');
    // Nothing is stored, and no prices or token went to the customer: it is built and checked first.
    expect(db.prepare(`SELECT COUNT(*) AS n FROM menu_snapshots`).get()).toEqual({ n: 0 });
    expect(res.json()).not.toHaveProperty('menuToken');
    expect(res.json()).not.toHaveProperty('sizes');
  });

  it.each([
    ['an item with two prices in effect', () => db.exec(`INSERT INTO prices (menu_item_id, price_type, amount, effective_from) SELECT id, 'static', 999, '2026-01-01T00:00:00.000Z' FROM menu_items WHERE code = 'small'`)],
    ['an item with no price', () => db.exec(`DELETE FROM prices WHERE menu_item_id = (SELECT id FROM menu_items WHERE code = 'medium')`)],
    ['no tax rate in effect', () => db.exec(`DELETE FROM tax_rates`)],
  ])('the same holds for inconsistent menu data: %s', async (_label, breakIt) => {
    breakIt();
    const res = await app.inject({ method: 'GET', url: '/menu' });
    expect(res.statusCode).toBe(503);
    expect(db.prepare(`SELECT COUNT(*) AS n FROM menu_snapshots`).get()).toEqual({ n: 0 });
    expect(res.json()).not.toHaveProperty('menuToken');
  });
});

describe('what a snapshot holds', () => {
  it('is stored with exactly what the customer was shown, including price ids and the tax rate', async () => {
    const body = await getMenu();
    const stored = findSnapshot(db, body.menuToken, clock)!;

    expect(stored.data.sizes.map((s) => [s.code, s.priceCents])).toEqual([['small', 500], ['medium', 700], ['large', 1200]]);
    expect(stored.data.taxRate).toMatchObject({ rateBps: 650 });
    expect(stored.data.toppings).toHaveLength(12);
    expect(stored.data.toppings.every((t) => Number.isInteger(t.priceId))).toBe(true);
    expect(stored.expiresAt).toBe(body.expiresAt);
  });

  it('knows a token it never issued', () => {
    expect(findSnapshot(db, 'not-a-real-token', clock)).toBeNull();
  });

  it('is expired exactly at its deadline, not a moment before', async () => {
    const { menuToken } = await getMenu();
    expect(findSnapshot(db, menuToken, new Date(at(30).getTime() - 1))!.expired).toBe(false);
    expect(findSnapshot(db, menuToken, at(30))!.expired).toBe(true);
  });
});

describe('prices are locked to the menu the customer was shown', () => {
  it('a price change made after the menu was loaded does not change that snapshot', async () => {
    const before = await getMenu();

    clock = at(5);
    setLarge(1300); // the restaurant raises the large to $13.00
    const after = await getMenu();

    const large = (m: { sizes: { code: string; priceCents: number }[] }) => m.sizes.find((s) => s.code === 'large')!.priceCents;
    expect(large(after)).toBe(1300); // new customers see the new price...
    expect(after.menuToken).not.toBe(before.menuToken);
    // ...but the customer who loaded the menu earlier is still held to the price they were shown
    const lockedIn = findSnapshot(db, before.menuToken, clock)!;
    expect(large(lockedIn.data)).toBe(1200);
    expect(lockedIn.data.toppings[0]!.pricesCents.large).toBe(96); // and 8% of the OLD price
    expect(lockedIn.expired).toBe(false);
  });

  it('a scheduled price change is picked up by the first menu loaded after it takes effect', async () => {
    const id = (db.prepare(`SELECT id FROM menu_items WHERE code = 'large'`).get() as { id: number }).id;
    db.prepare(`UPDATE prices SET effective_to = '2026-06-15T12:10:00.000Z' WHERE menu_item_id = ? AND effective_to IS NULL`).run(id);
    db.prepare(`INSERT INTO prices (menu_item_id, price_type, amount, effective_from) VALUES (?, 'static', 1300, '2026-06-15T12:10:00.000Z')`).run(id);

    const early = await getMenu(); // 12:00, before the change
    clock = at(10); // exactly when the new price starts
    const late = await getMenu();

    expect(early.sizes.find((s: { code: string }) => s.code === 'large').priceCents).toBe(1200);
    expect(late.sizes.find((s: { code: string }) => s.code === 'large').priceCents).toBe(1300);
    expect(late.menuToken).not.toBe(early.menuToken);
  });
});

describe('sharing snapshots', () => {
  it('customers loading identical prices shortly apart share one snapshot (and one deadline)', async () => {
    const first = await getMenu();
    clock = at(2);
    const second = await getMenu();

    expect(second.menuToken).toBe(first.menuToken);
    expect(second.expiresAt).toBe(first.expiresAt);
    expect(db.prepare(`SELECT COUNT(*) AS n FROM menu_snapshots`).get()).toEqual({ n: 1 });
  });

  it('a snapshot with too little life left is not handed to a new customer', async () => {
    const first = await getMenu();
    clock = at(6); // only 24 of 30 minutes remain: under the 5/6 threshold (25 minutes)
    const second = await getMenu();

    expect(second.menuToken).not.toBe(first.menuToken);
    expect(second.expiresAt).toBe(at(36).toISOString()); // the new customer gets a full window
  });

  it('exactly at the threshold it is still shared', async () => {
    const first = await getMenu();
    clock = at(5); // exactly 25 minutes remain
    expect((await getMenu()).menuToken).toBe(first.menuToken);
  });

  it('every customer is given at least 5/6 of the window', async () => {
    for (let minute = 0; minute <= 90; minute += 1) {
      clock = at(minute);
      const body = await getMenu();
      const remainingMs = new Date(body.expiresAt).getTime() - clock.getTime();
      expect(remainingMs).toBeGreaterThanOrEqual(25 * 60_000);
    }
    // 91 requests over 90 minutes, but at most one new snapshot per 5 minutes
    expect((db.prepare(`SELECT COUNT(*) AS n FROM menu_snapshots`).get() as { n: number }).n).toBeLessThanOrEqual(18);
  });

  it('getOrCreateSnapshot returns null when no menu is in effect', () => {
    expect(getOrCreateSnapshot(db, new Date('2020-01-01T00:00:00.000Z'))).toBeNull();
  });
});

describe('cleaning up', () => {
  it('removes expired snapshots nobody ordered from, and keeps the rest', () => {
    const add = (token: string, createdMin: number, expiresMin: number) =>
      db
        .prepare(
          `INSERT INTO menu_snapshots (token, menu_id, content_hash, data, created_at, expires_at)
           VALUES (?, 1, ?, '{}', ?, ?)`,
        )
        .run(token, token, at(createdMin).toISOString(), at(expiresMin).toISOString());
    add('expired-unused', -60, -30);
    add('expired-but-ordered', -60, -30);
    add('still-valid', 0, 30);
    insertOrder(db);
    db.prepare(`UPDATE orders SET menu_snapshot_token = 'expired-but-ordered'`).run();
    db.exec(`DELETE FROM menu_snapshots WHERE token = 'test-snapshot'`); // the helper's stub, now unused

    const removed = purgeExpiredSnapshots(db, clock);

    const tokens = (db.prepare(`SELECT token FROM menu_snapshots`).all() as { token: string }[]).map((r) => r.token);
    expect(tokens).toContain('expired-but-ordered'); // expired, but an order refers to it
    expect(tokens).toContain('still-valid'); // not expired
    expect(tokens).not.toContain('expired-unused'); // expired and unreferenced
    expect(removed).toBe(1);
  });

  it('never deletes a snapshot an order refers to, even long after it expired', async () => {
    const { menuToken } = await getMenu();
    insertOrder(db);
    db.prepare(`UPDATE orders SET menu_snapshot_token = ?`).run(menuToken);

    purgeExpiredSnapshots(db, new Date('2030-01-01T00:00:00.000Z'));

    expect(findSnapshot(db, menuToken, clock)).not.toBeNull();
  });
});

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { DatabaseSync } from 'node:sqlite';
import { buildApp } from '../../src/service/app.js';
import { openDatabase } from '../../src/service/db.js';

let db: DatabaseSync;
let app: FastifyInstance;
let clock = new Date('2026-06-15T12:00:00.000Z');

beforeEach(() => {
  clock = new Date('2026-06-15T12:00:00.000Z');
  db = openDatabase({ path: ':memory:', seed: true });
  app = buildApp({ db, now: () => clock });
});
afterEach(async () => {
  await app.close();
  db.close();
});

const getMenu = () => app.inject({ method: 'GET', url: '/menu' });

describe('GET /menu with the seed data (the brief\'s menu)', () => {
  it('has the three sizes at $5, $7 and $12, in order', async () => {
    const body = (await getMenu()).json();
    expect(body.sizes).toEqual([
      { code: 'small', label: 'Small', priceCents: 500, priceId: expect.any(Number) },
      { code: 'medium', label: 'Medium', priceCents: 700, priceId: expect.any(Number) },
      { code: 'large', label: 'Large', priceCents: 1200, priceId: expect.any(Number) },
    ]);
  });

  it('has exactly the six basic and six premium toppings from the brief', async () => {
    const { toppings } = (await getMenu()).json();
    const byCategory = (c: string) => toppings.filter((t: { category: { code: string } }) => t.category?.code === c).map((t: { label: string }) => t.label);

    expect(byCategory('basic')).toEqual(['Pepperoni', 'Sausage', 'Extra cheese', 'Onions', 'Black olives', 'Green peppers']);
    expect(byCategory('premium')).toEqual(['Bacon', 'Chicken', 'Garlic', 'Artichoke hearts', 'Sun-dried tomatoes', 'Pineapple']);
    expect(toppings).toHaveLength(12);
  });

  it('prices basic toppings at 8% and premium at 11% of each size, in whole cents', async () => {
    const { toppings } = (await getMenu()).json();
    const price = (label: string) => toppings.find((t: { label: string }) => t.label === label);

    expect(price('Pepperoni').price).toEqual({ type: 'percentage', amount: 800 });
    expect(price('Pepperoni').pricesCents).toEqual({ small: 40, medium: 56, large: 96 });
    expect(price('Bacon').price).toEqual({ type: 'percentage', amount: 1100 });
    expect(price('Bacon').pricesCents).toEqual({ small: 55, medium: 77, large: 132 });
  });

  it('every topping is priced for every size', async () => {
    const { sizes, toppings } = (await getMenu()).json();
    for (const t of toppings) expect(Object.keys(t.pricesCents).sort()).toEqual(sizes.map((s: { code: string }) => s.code).sort());
  });

  it('names the menu and its window', async () => {
    expect((await getMenu()).json().menu).toMatchObject({ name: 'Standard Menu', effectiveTo: null });
  });
});

describe('GET /menu: what is in effect when', () => {
  it('is unavailable before the menu starts', async () => {
    clock = new Date('2025-12-31T23:59:59.000Z');
    const res = await getMenu();
    expect(res.statusCode).toBe(503);
    expect(res.json().error).toBe('no_active_menu');
  });

  it('is unavailable when the only menu is switched off', async () => {
    db.exec(`UPDATE menus SET active = 0`);
    expect((await getMenu()).json().error).toBe('no_active_menu');
  });

  it('hides inactive items', async () => {
    db.exec(`UPDATE menu_items SET active = 0 WHERE code IN ('pineapple', 'small')`);
    const body = (await getMenu()).json();
    expect(body.toppings.map((t: { code: string }) => t.code)).not.toContain('pineapple');
    expect(body.sizes.map((s: { code: string }) => s.code)).toEqual(['medium', 'large']);
    expect(body.toppings[0].pricesCents).not.toHaveProperty('small');
  });

  it('uses the price whose window contains now, so a price change takes effect on schedule', async () => {
    // Large goes from $12 to $13 on July 1st.
    const large = (db.prepare(`SELECT id FROM menu_items WHERE code = 'large'`).get() as { id: number }).id;
    db.prepare(`UPDATE prices SET effective_to = '2026-07-01T00:00:00.000Z' WHERE menu_item_id = ?`).run(large);
    db.prepare(`INSERT INTO prices (menu_item_id, price_type, amount, effective_from) VALUES (?, 'static', 1300, '2026-07-01T00:00:00.000Z')`).run(large);

    const before = (await getMenu()).json();
    clock = new Date('2026-07-01T00:00:00.000Z');
    const after = (await getMenu()).json();

    const large$ = (b: { sizes: { code: string; priceCents: number }[] }) => b.sizes.find((s) => s.code === 'large')!.priceCents;
    expect(large$(before)).toBe(1200);
    expect(large$(after)).toBe(1300);
    // Percentage toppings follow the new base price: 8% of $13.00 = $1.04.
    expect(after.toppings[0].pricesCents.large).toBe(104);
  });

  it('a static topping price does not depend on the size', async () => {
    const pep = (db.prepare(`SELECT id FROM menu_items WHERE code = 'pepperoni'`).get() as { id: number }).id;
    db.prepare(`UPDATE prices SET price_type = 'static', amount = 150 WHERE menu_item_id = ?`).run(pep);
    expect((await getMenu()).json().toppings[0].pricesCents).toEqual({ small: 150, medium: 150, large: 150 });
  });
});

describe('GET /menu: bad data is refused, not guessed at', () => {
  it('an item with two prices in effect is a 503 menu_misconfigured', async () => {
    const small = (db.prepare(`SELECT id FROM menu_items WHERE code = 'small'`).get() as { id: number }).id;
    db.prepare(`INSERT INTO prices (menu_item_id, price_type, amount, effective_from) VALUES (?, 'static', 999, '2026-01-01T00:00:00.000Z')`).run(small);
    const res = await getMenu();
    expect(res.statusCode).toBe(503);
    expect(res.json().error).toBe('menu_misconfigured');
  });

  it('an item with no price in effect is a 503 menu_misconfigured', async () => {
    db.exec(`DELETE FROM prices WHERE menu_item_id = (SELECT id FROM menu_items WHERE code = 'medium')`);
    expect((await getMenu()).json().error).toBe('menu_misconfigured');
  });
});

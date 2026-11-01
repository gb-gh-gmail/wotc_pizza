import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { runInTransaction } from '../../src/service/db.js';

export interface TestLine {
  size: string;
  quantity?: number;
  toppings?: string[];
}

export interface TestOrder {
  id?: string;
  status?: string;
  createdAt?: string;
  lines?: TestLine[];
}

/**
 * Insert an order directly into a seeded database. Prices are looked up from the
 * seeded menu, but totals are NOT computed here: tests of the kitchen screen only
 * care about status, timing and contents. (Real pricing is covered by the pricing tests.)
 */
export function insertOrder(db: DatabaseSync, o: TestOrder = {}): string {
  const id = o.id ?? randomUUID();
  const createdAt = o.createdAt ?? '2026-03-01T12:00:00.000Z';
  const lines = o.lines ?? [{ size: 'large', quantity: 1, toppings: ['pepperoni'] }];

  const itemId = (type: string, code: string) =>
    (db
      .prepare(
        `SELECT i.id FROM menu_items i JOIN menu_item_types t ON t.id = i.type_id WHERE t.code = ? AND i.code = ?`,
      )
      .get(type, code) as { id: number } | undefined)?.id ?? (() => { throw new Error(`no seeded ${type} ${code}`); })();
  const priceId = (menuItemId: number) =>
    (db.prepare(`SELECT id FROM prices WHERE menu_item_id = ?`).get(menuItemId) as { id: number }).id;

  runInTransaction(db, () => {
    db.prepare(
      `INSERT INTO orders (id, status, menu_id, subtotal_cents, tax_rate_id, tax_cents, total_cents, created_at, updated_at)
       VALUES (?, ?, (SELECT id FROM menus LIMIT 1), 1000, (SELECT id FROM tax_rates LIMIT 1), 65, 1065, ?, ?)`,
    ).run(id, o.status ?? 'NOT_STARTED', createdAt, createdAt);

    lines.forEach((line, position) => {
      const sizeId = itemId('size', line.size);
      const { lastInsertRowid } = db
        .prepare(
          `INSERT INTO order_items (order_id, position, size_item_id, price_id, quantity, base_price_cents, unit_price_cents, line_total_cents)
           VALUES (?, ?, ?, ?, ?, 1200, 1200, 1200)`,
        )
        .run(id, position, sizeId, priceId(sizeId), line.quantity ?? 1);
      for (const code of line.toppings ?? []) {
        const toppingId = itemId('topping', code);
        db.prepare(
          `INSERT INTO order_item_toppings (order_item_id, topping_item_id, price_id, price_cents) VALUES (?, ?, ?, 96)`,
        ).run(lastInsertRowid, toppingId, priceId(toppingId));
      }
    });
  });
  return id;
}

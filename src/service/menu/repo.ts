import type { DatabaseSync } from 'node:sqlite';
import { toppingPriceCents, type MenuSnapshot, type PriceRule } from '../../core/menu.js';

/** The menu data is inconsistent (e.g. an item with two prices in effect). A config error, not a client error. */
export class MenuConfigError extends Error {}

interface ItemRow {
  id: number;
  type: string;
  code: string;
  label: string;
  category_code: string | null;
  category_label: string | null;
}

/** The price row in effect for an item at `at`. Zero or several are a data error: refuse rather than guess. */
function priceInEffect(db: DatabaseSync, item: ItemRow, at: string): PriceRule & { id: number } {
  const rows = db
    .prepare(
      `SELECT id, price_type, amount FROM prices
        WHERE menu_item_id = ? AND effective_from <= ? AND (effective_to IS NULL OR ? < effective_to)`,
    )
    .all(item.id, at, at) as { id: number; price_type: 'static' | 'percentage'; amount: number }[];
  if (rows.length !== 1) {
    throw new MenuConfigError(`menu item "${item.code}" has ${rows.length} prices in effect at ${at}, expected exactly 1`);
  }
  const row = rows[0]!;
  return { id: row.id, type: row.price_type, amount: row.amount };
}

/** The tax rate in effect at `at`. Windows cannot overlap (triggers), but a gap is a config error. */
function taxRateInEffect(db: DatabaseSync, at: string): MenuSnapshot['taxRate'] {
  const rows = db
    .prepare(
      `SELECT id, name, rate_bps FROM tax_rates WHERE effective_from <= ? AND (effective_to IS NULL OR ? < effective_to)`,
    )
    .all(at, at) as { id: number; name: string; rate_bps: number }[];
  if (rows.length !== 1) throw new MenuConfigError(`${rows.length} tax rates in effect at ${at}, expected exactly 1`);
  return { id: rows[0]!.id, name: rows[0]!.name, rateBps: rows[0]!.rate_bps };
}

/** The menu in effect at `at` with every price (and the tax rate) resolved, or null if no menu is. */
export function getActiveMenu(db: DatabaseSync, at: Date): MenuSnapshot | null {
  const now = at.toISOString();

  // Overlapping active menus are blocked by triggers, so there is at most one.
  const menu = db
    .prepare(
      `SELECT id, name, description, effective_from, effective_to FROM menus
        WHERE active = 1 AND effective_from <= ? AND (effective_to IS NULL OR ? < effective_to)`,
    )
    .get(now, now) as
    | { id: number; name: string; description: string | null; effective_from: string; effective_to: string | null }
    | undefined;
  if (!menu) return null;

  const items = db
    .prepare(
      `SELECT i.id, t.code AS type, i.code, i.label, c.code AS category_code, c.label AS category_label
         FROM menu_items i
         JOIN menu_item_types t ON t.id = i.type_id
         LEFT JOIN menu_categories c ON c.id = i.category_id
        WHERE i.menu_id = ? AND i.active = 1
        ORDER BY i.sort_order, i.id`,
    )
    .all(menu.id) as unknown as ItemRow[];

  const sizes = items
    .filter((i) => i.type === 'size')
    .map((item) => {
      const price = priceInEffect(db, item, now);
      if (price.type !== 'static') throw new MenuConfigError(`size "${item.code}" must have a static price`);
      return { code: item.code, label: item.label, priceCents: price.amount, priceId: price.id };
    });

  const toppings = items
    .filter((i) => i.type === 'topping')
    .map((item) => {
      const { id, ...rule } = priceInEffect(db, item, now);
      return {
        code: item.code,
        label: item.label,
        category: item.category_code ? { code: item.category_code, label: item.category_label! } : null,
        price: rule,
        priceId: id,
        pricesCents: Object.fromEntries(sizes.map((s) => [s.code, toppingPriceCents(rule, s.priceCents)])),
      };
    });

  return {
    menu: {
      id: menu.id,
      name: menu.name,
      description: menu.description,
      effectiveFrom: menu.effective_from,
      effectiveTo: menu.effective_to,
    },
    sizes,
    toppings,
    taxRate: taxRateInEffect(db, now),
    pricedAt: now,
  };
}

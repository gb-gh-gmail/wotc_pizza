/**
 * What placing an order and changing an order have in common. Both take a submission (a menu
 * session, an order and the figures the customer was shown), must be priced and checked by exactly
 * the same rules, and write the same things (lines, toppings, promos, a revision). Keeping that in
 * one place is what stops the two from drifting apart.
 */
import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { Claimed, Difference } from '../../core/claims.js';
import type { Breakdown, Issue, OrderInput } from '../../core/pricing.js';
import { quoteOrder } from '../quote/service.js';

export interface Submission {
  /** The menu the customer was shown; the order is priced from it, not from today's prices. */
  menuToken: string;
  order: OrderInput;
  /** What the page is showing. The total is required: without it there is nothing to confirm against. */
  claimed: Claimed & { totalCents: number };
  /** Explicit confirmations. A very large tip is only accepted if the customer confirmed THIS amount. */
  confirmations?: { largeTipCents?: number };
}

/** Why a submission was held instead of accepted. */
export type HoldReason =
  | 'prices_changed' // what the page showed differs from what the service computes
  | 'promo_removed' // a promo code in the order no longer applies
  | 'large_tip'; // the tip is half the bill or more and has not been confirmed

export interface Held {
  kind: 'held';
  reasons: HoldReason[];
  /** The authoritative figures for the customer to review. */
  quote: Breakdown;
  differences: Difference[];
  /** Codes in the order that were refused. */
  removedPromos: string[];
  menuToken: string;
  expiresAt: string;
}

export type Assessment =
  | { kind: 'ready'; breakdown: Breakdown }
  | Held
  | { kind: 'menu_unknown' }
  | { kind: 'menu_expired'; expiredAt: string }
  | { kind: 'invalid_order'; issues: Issue[] };

/** JSON with sorted keys, so the same value always has the same text. */
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    const o = value as Record<string, unknown>;
    return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

export const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');

/**
 * Price the submission and check everything the customer can have changed since they last looked.
 * It re-prices from the stored menu snapshot, re-checks every promo against the live promo table
 * and checks the tip. It either says the submission is `ready` to be written, or why it is not:
 * bad data, an unusable session, or something the customer has not seen and agreed to (`held`).
 * It writes nothing.
 */
export function assess(db: DatabaseSync, s: Submission, now: Date): Assessment {
  const quote = quoteOrder(db, { menuToken: s.menuToken, order: s.order, claimed: s.claimed }, now);
  if (quote.kind === 'menu_unknown') return { kind: 'menu_unknown' };
  if (quote.kind === 'menu_expired') return { kind: 'menu_expired', expiredAt: quote.expiredAt };
  if (quote.kind === 'invalid_order') return { kind: 'invalid_order', issues: quote.issues };

  // Anything the customer has not seen and agreed to holds the submission.
  const b = quote.breakdown;
  const removedPromos = b.promos.filter((p) => !p.applied).map((p) => p.code);
  const reasons: HoldReason[] = [];
  if (quote.differences.length > 0) reasons.push('prices_changed');
  if (removedPromos.length > 0) reasons.push('promo_removed');
  if (b.tip.needsConfirmation && s.confirmations?.largeTipCents !== b.tip.cents) reasons.push('large_tip');
  if (reasons.length > 0) {
    return { kind: 'held', reasons, quote: b, differences: quote.differences, removedPromos, menuToken: quote.menuToken, expiresAt: quote.expiresAt };
  }
  return { kind: 'ready', breakdown: b };
}

/** The tip as the customer entered it: cents for a dollar tip, basis points for a percentage. */
export function tipColumns(order: OrderInput): { tipMode: string; tipInput: number } {
  const tip = order.tip ?? { mode: 'none' as const };
  return { tipMode: tip.mode, tipInput: tip.mode === 'amount' ? tip.cents : tip.mode === 'percent' ? tip.bps : 0 };
}

/**
 * The priced content of an order as canonical text: what was ordered and at what prices. Two orders
 * with the same text are the same order, which is how a change that changes nothing is recognised.
 */
export function contentsOf(b: Breakdown, order: OrderInput): string {
  const { tipMode, tipInput } = tipColumns(order);
  return canonical({
    lines: b.lines.map((l) => ({
      size: { code: l.size.code, priceCents: l.size.priceCents },
      quantity: l.quantity,
      toppings: l.toppings.map((t) => ({ code: t.code, priceCents: t.priceCents })),
      unitCents: l.unitCents,
      lineTotalCents: l.lineTotalCents,
    })),
    promos: b.promos.filter((p) => p.applied).map((p) => ({ code: p.code, discountCents: p.discountCents })),
    tip: { mode: tipMode, input: tipInput, cents: b.tip.cents },
    totals: { subtotalCents: b.subtotalCents, discountCents: b.discountCents, taxCents: b.taxCents, totalCents: b.totalCents },
  });
}

/** Write an order's lines, toppings and applied promos. The order row itself is the caller's. */
export function insertOrderBody(db: DatabaseSync, orderId: string, b: Breakdown): void {
  const itemId = db.prepare(
    `SELECT i.id FROM menu_items i JOIN menu_item_types t ON t.id = i.type_id WHERE i.menu_id = ? AND t.code = ? AND i.code = ?`,
  );
  const lookup = (type: 'size' | 'topping', code: string): number => {
    const row = itemId.get(b.menuId, type, code) as { id: number } | undefined;
    if (!row) throw new Error(`${type} "${code}" is in the quote but not in menu ${b.menuId}`);
    return row.id;
  };
  const insertLine = db.prepare(
    `INSERT INTO order_items (order_id, position, size_item_id, price_id, quantity, base_price_cents, unit_price_cents, line_total_cents)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const insertTopping = db.prepare(
    `INSERT INTO order_item_toppings (order_item_id, topping_item_id, price_id, price_cents) VALUES (?, ?, ?, ?)`,
  );
  b.lines.forEach((line, position) => {
    const { lastInsertRowid } = insertLine.run(orderId, position, lookup('size', line.size.code), line.size.priceId, line.quantity, line.size.priceCents, line.unitCents, line.lineTotalCents);
    for (const t of line.toppings) insertTopping.run(lastInsertRowid, lookup('topping', t.code), t.priceId, t.priceCents);
  });

  const promoId = db.prepare(`SELECT id FROM promos WHERE code = ?`);
  for (const p of b.promos.filter((x) => x.applied)) {
    const row = promoId.get(p.code) as { id: number } | undefined;
    if (!row) throw new Error(`promo "${p.code}" applied but not found`);
    db.prepare(`INSERT INTO order_promos (order_id, promo_id, discount_cents) VALUES (?, ?, ?)`).run(orderId, row.id, p.discountCents);
  }
}

/** Record this version of the order. Returns its revision number (1 for the order as first placed). */
export function recordRevision(db: DatabaseSync, orderId: string, b: Breakdown, s: Submission, now: Date): number {
  const { n } = db.prepare(`SELECT COALESCE(MAX(revision), 0) AS n FROM order_revisions WHERE order_id = ?`).get(orderId) as { n: number };
  const revision = n + 1;
  db.prepare(
    `INSERT INTO order_revisions (order_id, revision, menu_snapshot_token, subtotal_cents, discount_cents, tax_cents, tip_cents, total_cents, contents, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(orderId, revision, s.menuToken, b.subtotalCents, b.discountCents, b.taxCents, b.tip.cents, b.totalCents, contentsOf(b, s.order), now.toISOString());
  return revision;
}

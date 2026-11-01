import type { DatabaseSync } from 'node:sqlite';
import type { PromoDef } from '../../core/promos.js';

interface PromoRow {
  code: string;
  kind: string;
  percent_bps: number | null;
  amount_cents: number | null;
  min_subtotal_cents: number | null;
  exclusive: number;
}

/**
 * The promos a customer can use at `at`: switched on, started, and not yet ended
 * (start inclusive, end exclusive, like every other window). Read afresh on every
 * quote and order, so a promo that is switched off or expires is refused at once,
 * even for a customer who applied it a minute ago.
 */
export function loadPromos(db: DatabaseSync, at: Date): PromoDef[] {
  const now = at.toISOString();
  const rows = db
    .prepare(
      `SELECT code, kind, percent_bps, amount_cents, min_subtotal_cents, exclusive FROM promos
        WHERE active = 1
          AND (starts_at IS NULL OR starts_at <= ?)
          AND (ends_at IS NULL OR ? < ends_at)
        ORDER BY code`,
    )
    .all(now, now) as unknown as PromoRow[];
  return rows.map((r) => ({
    code: r.code,
    kind: r.kind,
    percentBps: r.percent_bps,
    amountCents: r.amount_cents,
    minSubtotalCents: r.min_subtotal_cents,
    exclusive: r.exclusive === 1,
  }));
}

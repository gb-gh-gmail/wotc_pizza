import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { runInTransaction } from '../db.js';
import { getOrder, type OrderView } from './repo.js';
import { assess, canonical, insertOrderBody, recordRevision, sha256, tipColumns, type Held, type Submission } from './write.js';
import type { Issue } from '../../core/pricing.js';

export type { HoldReason } from './write.js';

export interface PlaceRequest extends Submission {
  /** Chosen by the client, once per submission; makes a retry safe (docs/decisions-detailed.md D29). */
  idempotencyKey: string;
}

export type PlaceOutcome =
  | { kind: 'placed'; order: OrderView; replayed: boolean }
  | Held
  | { kind: 'menu_unknown' }
  | { kind: 'menu_expired'; expiredAt: string }
  | { kind: 'invalid_order'; issues: Issue[] }
  | { kind: 'idempotency_conflict' };

/**
 * What identifies "the same submission": the menu and the order. The claimed figures and the
 * confirmations are deliberately left out, so the same order sent again after the customer
 * accepted an updated price is still recognised as the same order.
 */
const requestHash = (r: PlaceRequest): string => sha256(canonical({ menuToken: r.menuToken, order: r.order }));

/**
 * Place an order, or say why it was not placed. Re-validates everything the customer can
 * have changed since they last looked (see `assess`). Nothing is written unless every check
 * passes, and the whole thing runs in one transaction, so a failure leaves no half-order behind.
 */
export function placeOrder(db: DatabaseSync, request: PlaceRequest, now: Date): PlaceOutcome {
  return runInTransaction(db, (): PlaceOutcome => {
    // 1. Is this a retry? Answered before anything else, so a retry still gets its order
    //    even if the menu session has expired in the meantime.
    const hash = requestHash(request);
    const seen = db.prepare(`SELECT request_hash, order_id FROM idempotency_keys WHERE key = ?`).get(request.idempotencyKey) as
      | { request_hash: string; order_id: string }
      | undefined;
    if (seen) {
      if (seen.request_hash !== hash) return { kind: 'idempotency_conflict' };
      return { kind: 'placed', order: getOrder(db, seen.order_id, 'customer')!, replayed: true };
    }

    // 2. Price it and check it; anything that is not ready is returned as it is.
    const a = assess(db, request, now);
    if (a.kind !== 'ready') return a;

    // 3. Write it all, or nothing.
    const id = randomUUID();
    const at = now.toISOString();
    const b = a.breakdown;
    const { tipMode, tipInput } = tipColumns(request.order);
    db.prepare(
      `INSERT INTO orders (id, status, menu_id, menu_snapshot_token, tip_mode, tip_input,
                           subtotal_cents, discount_cents, tax_rate_id, tax_cents, tip_cents, total_cents, created_at, updated_at)
       VALUES (?, 'NOT_STARTED', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, b.menuId, request.menuToken, tipMode, tipInput, b.subtotalCents, b.discountCents, b.taxRateId, b.taxCents, b.tip.cents, b.totalCents, at, at);
    insertOrderBody(db, id, b);
    db.prepare(`INSERT INTO order_status_events (order_id, from_status, to_status, actor, at) VALUES (?, NULL, 'NOT_STARTED', 'customer', ?)`).run(id, at);
    recordRevision(db, id, b, request, now);
    db.prepare(`INSERT INTO idempotency_keys (key, request_hash, order_id, created_at) VALUES (?, ?, ?, ?)`).run(request.idempotencyKey, hash, id, at);

    return { kind: 'placed', order: getOrder(db, id, 'customer')!, replayed: false };
  });
}

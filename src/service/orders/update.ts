import type { DatabaseSync } from 'node:sqlite';
import type { Issue } from '../../core/pricing.js';
import { runInTransaction } from '../db.js';
import { getOrder, type OrderView } from './repo.js';
import { canEdit, type OrderStatus } from './state.js';
import { assess, canonical, contentsOf, insertOrderBody, recordRevision, sha256, tipColumns, type Held, type Submission } from './write.js';

export interface UpdateRequest extends Submission {
  orderId: string;
  /** Chosen by the client, once per submission; makes a retry safe (docs/decisions.md D29). */
  idempotencyKey: string;
  /** The version of the order the customer was looking at. The change is only applied to that version. */
  expectedVersion: number;
}

export type UpdateOutcome =
  | {
      kind: 'updated';
      order: OrderView;
      /** The order's total before this change (null when this is a repeat of a change already made). */
      previousTotalCents: number | null;
      /** Nothing in the order differs from what it already was, so nothing was written. */
      unchanged: boolean;
      replayed: boolean;
    }
  | Held
  | { kind: 'menu_unknown' }
  | { kind: 'menu_expired'; expiredAt: string }
  | { kind: 'invalid_order'; issues: Issue[] }
  | { kind: 'not_found' }
  /** The kitchen has started (or finished) the order: it can no longer be changed. */
  | { kind: 'order_locked'; currentStatus: OrderStatus }
  | { kind: 'order_cancelled' }
  /** The order was changed since the customer loaded it (another window); they must reload it. */
  | { kind: 'order_changed'; order: OrderView }
  | { kind: 'idempotency_conflict' };

/**
 * Change an order's pizzas, tip or promos, but only while the kitchen has not started it. The order
 * is re-priced and re-checked by exactly the rules used to place it (`assess`), the whole change
 * runs in one transaction, and the write itself is conditional on the order still being Not Started
 * and still at the version the customer saw, so a change racing the kitchen starting the order has
 * exactly one winner. Nothing is written unless every check passes.
 */
export function updateOrder(db: DatabaseSync, request: UpdateRequest, now: Date): UpdateOutcome {
  return runInTransaction(db, (): UpdateOutcome => {
    // 1. Is this a retry? Answered first, so a retry gets its answer even if the order has since moved on.
    const hash = sha256(canonical({ orderId: request.orderId, menuToken: request.menuToken, order: request.order }));
    const seen = db.prepare(`SELECT request_hash, order_id FROM idempotency_keys WHERE key = ?`).get(request.idempotencyKey) as
      | { request_hash: string; order_id: string }
      | undefined;
    if (seen) {
      if (seen.request_hash !== hash || seen.order_id !== request.orderId) return { kind: 'idempotency_conflict' };
      return { kind: 'updated', order: getOrder(db, seen.order_id, 'customer')!, previousTotalCents: null, unchanged: false, replayed: true };
    }

    // 2. Can this order still be changed, and is it the version the customer was looking at?
    const row = db.prepare(`SELECT status, version, total_cents FROM orders WHERE id = ?`).get(request.orderId) as
      | { status: OrderStatus; version: number; total_cents: number }
      | undefined;
    if (!row) return { kind: 'not_found' };
    if (row.status === 'CANCELLED') return { kind: 'order_cancelled' };
    if (!canEdit(row.status, 'customer')) return { kind: 'order_locked', currentStatus: row.status };
    if (row.version !== request.expectedVersion) return { kind: 'order_changed', order: getOrder(db, request.orderId, 'customer')! };

    // 3. Price it and check it, by the same rules as placing; anything that is not ready is returned as it is.
    const a = assess(db, request, now);
    if (a.kind !== 'ready') return a;
    const b = a.breakdown;

    // 4. A change that changes nothing is not a change.
    const latest = db.prepare(`SELECT contents FROM order_revisions WHERE order_id = ? ORDER BY revision DESC LIMIT 1`).get(request.orderId) as
      | { contents: string }
      | undefined;
    if (latest && latest.contents === contentsOf(b, request.order)) {
      return { kind: 'updated', order: getOrder(db, request.orderId, 'customer')!, previousTotalCents: row.total_cents, unchanged: true, replayed: false };
    }

    // 5. Write it all, or nothing. The WHERE is the real guard: it only matches an order that is
    //    still Not Started and still at the version the customer saw.
    const { tipMode, tipInput } = tipColumns(request.order);
    const changed = db
      .prepare(
        `UPDATE orders SET menu_id = ?, menu_snapshot_token = ?, tip_mode = ?, tip_input = ?, subtotal_cents = ?, discount_cents = ?,
                tax_rate_id = ?, tax_cents = ?, tip_cents = ?, total_cents = ?, version = version + 1, updated_at = ?
          WHERE id = ? AND status = 'NOT_STARTED' AND version = ?`,
      )
      .run(b.menuId, request.menuToken, tipMode, tipInput, b.subtotalCents, b.discountCents, b.taxRateId, b.taxCents, b.tip.cents, b.totalCents, now.toISOString(), request.orderId, request.expectedVersion);
    if (Number(changed.changes) !== 1) throw new Error(`lost update on order ${request.orderId}`);

    db.prepare(`DELETE FROM order_items WHERE order_id = ?`).run(request.orderId); // its toppings go with it
    db.prepare(`DELETE FROM order_promos WHERE order_id = ?`).run(request.orderId);
    insertOrderBody(db, request.orderId, b);
    recordRevision(db, request.orderId, b, request, now);
    db.prepare(`INSERT INTO idempotency_keys (key, request_hash, order_id, created_at) VALUES (?, ?, ?, ?)`).run(
      request.idempotencyKey,
      hash,
      request.orderId,
      now.toISOString(),
    );

    return { kind: 'updated', order: getOrder(db, request.orderId, 'customer')!, previousTotalCents: row.total_cents, unchanged: false, replayed: false };
  });
}

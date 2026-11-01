import type { DatabaseSync } from 'node:sqlite';
import { runInTransaction } from '../db.js';
import { canCancel, isOrderStatus, nextStatus, type Actor, type OrderStatus } from './state.js';

/** One order as a screen needs to see it. `canCancel` is computed for the viewer. */
export interface OrderView {
  id: string;
  status: OrderStatus;
  createdAt: string;
  updatedAt: string;
  version: number;
  totalCents: number;
  cancellationReason: string | null;
  items: { quantity: number; size: string; toppings: string[] }[];
  /** Computed here from the state machine so no UI carries rules of its own. */
  nextStatus: OrderStatus | null;
  canCancel: boolean;
}

/** Why a request was refused, as a stable code a client can act on. */
export type ConflictCode =
  | 'order_cancelled' // the order has been cancelled (by someone else, or earlier)
  | 'status_changed' // the order is not in the status the caller last saw
  | 'not_allowed'; // the rules do not allow this action from the current status

export type TransitionResult =
  | { kind: 'ok'; order: OrderView }
  | { kind: 'not_found' }
  | { kind: 'conflict'; code: ConflictCode; currentStatus: OrderStatus; message: string };

interface OrderRow {
  id: string;
  status: string;
  created_at: string;
  updated_at: string;
  version: number;
  total_cents: number;
  cancellation_reason: string | null;
}

const ORDER_COLUMNS = `id, status, created_at, updated_at, version, total_cents, cancellation_reason`;

function toView(db: DatabaseSync, row: OrderRow, viewer: Actor): OrderView {
  if (!isOrderStatus(row.status)) throw new Error(`order ${row.id} has unknown status ${row.status}`);
  const status = row.status;

  const lines = db
    .prepare(
      `SELECT oi.id, oi.quantity, s.label AS size
         FROM order_items oi JOIN menu_items s ON s.id = oi.size_item_id
        WHERE oi.order_id = ? ORDER BY oi.position`,
    )
    .all(row.id) as { id: number; quantity: number; size: string }[];
  const toppingsFor = db.prepare(
    `SELECT t.label FROM order_item_toppings oit JOIN menu_items t ON t.id = oit.topping_item_id
      WHERE oit.order_item_id = ? ORDER BY t.sort_order, t.label`,
  );

  return {
    id: row.id,
    status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    version: row.version,
    totalCents: row.total_cents,
    cancellationReason: row.cancellation_reason,
    items: lines.map((l) => ({
      quantity: l.quantity,
      size: l.size,
      toppings: (toppingsFor.all(l.id) as { label: string }[]).map((t) => t.label),
    })),
    nextStatus: nextStatus(status),
    canCancel: canCancel(status, viewer),
  };
}

export function getOrder(db: DatabaseSync, id: string, viewer: Actor): OrderView | null {
  const row = db.prepare(`SELECT ${ORDER_COLUMNS} FROM orders WHERE id = ?`).get(id) as OrderRow | undefined;
  return row ? toView(db, row, viewer) : null;
}

/** Newest first. By default only orders still needing attention; `includeClosed` adds delivered/cancelled. */
export function listOrders(
  db: DatabaseSync,
  viewer: Actor,
  opts: { includeClosed?: boolean; limit?: number } = {},
): OrderView[] {
  const where = opts.includeClosed ? '' : `WHERE status NOT IN ('DELIVERED', 'CANCELLED')`;
  const rows = db
    .prepare(`SELECT ${ORDER_COLUMNS} FROM orders ${where} ORDER BY created_at DESC, rowid DESC LIMIT ?`)
    .all(opts.limit ?? 200) as unknown as OrderRow[];
  return rows.map((r) => toView(db, r, viewer));
}

function recordEvent(db: DatabaseSync, id: string, from: OrderStatus, to: OrderStatus, actor: Actor, at: string): void {
  db.prepare(`INSERT INTO order_status_events (order_id, from_status, to_status, actor, at) VALUES (?, ?, ?, ?, ?)`).run(
    id,
    from,
    to,
    actor,
    at,
  );
}

type Done = { kind: 'done' };

/**
 * Move an order one step forward. The caller states which status it believes
 * the order is in; if it has changed (a double-click, another screen, the
 * order being cancelled) the call is refused rather than skipping a step.
 */
export function advanceOrder(
  db: DatabaseSync,
  id: string,
  expectedStatus: OrderStatus,
  actor: Actor,
  now: () => Date = () => new Date(),
): TransitionResult {
  const outcome = runInTransaction(db, (): TransitionResult | Done => {
    const row = db.prepare(`SELECT status FROM orders WHERE id = ?`).get(id) as { status: OrderStatus } | undefined;
    if (!row) return { kind: 'not_found' };

    if (row.status === 'CANCELLED') {
      return { kind: 'conflict', code: 'order_cancelled', currentStatus: row.status, message: 'Order has been cancelled' };
    }
    if (row.status !== expectedStatus) {
      return {
        kind: 'conflict',
        code: 'status_changed',
        currentStatus: row.status,
        message: `Order status has changed: it is now ${row.status}, not ${expectedStatus}`,
      };
    }
    const next = nextStatus(row.status);
    if (next === null) {
      return { kind: 'conflict', code: 'not_allowed', currentStatus: row.status, message: `Order is ${row.status} and cannot advance` };
    }

    const at = now().toISOString();
    // The WHERE on status is the actual guard; the SELECT above only chooses the message.
    const result = db
      .prepare(`UPDATE orders SET status = ?, version = version + 1, updated_at = ? WHERE id = ? AND status = ?`)
      .run(next, at, id, expectedStatus);
    if (result.changes !== 1) throw new Error(`lost update on order ${id}`);
    recordEvent(db, id, expectedStatus, next, actor, at);
    return { kind: 'done' };
  });

  if (outcome.kind !== 'done') return outcome;
  return { kind: 'ok', order: getOrder(db, id, actor)! };
}

/**
 * Cancel an order. The status is re-read here, inside the write transaction, at
 * the moment of the request, whatever the caller's screen last showed:
 *   - already cancelled        -> success, nothing changes (retries are safe; first reason kept)
 *   - `expectedStatus` differs -> refused: the caller was acting on stale information
 *   - actor not allowed        -> refused (customer after the kitchen has started; anyone after delivery)
 */
export function cancelOrder(
  db: DatabaseSync,
  id: string,
  opts: { actor: Actor; reason: string | null; expectedStatus?: OrderStatus },
  now: () => Date = () => new Date(),
): TransitionResult {
  const { actor, reason, expectedStatus } = opts;

  const outcome = runInTransaction(db, (): TransitionResult | Done => {
    const row = db.prepare(`SELECT status FROM orders WHERE id = ?`).get(id) as { status: OrderStatus } | undefined;
    if (!row) return { kind: 'not_found' };
    if (row.status === 'CANCELLED') return { kind: 'done' };

    if (expectedStatus !== undefined && row.status !== expectedStatus) {
      return {
        kind: 'conflict',
        code: 'status_changed',
        currentStatus: row.status,
        message: `Order status has changed since you last checked: it is now ${row.status}, not ${expectedStatus}`,
      };
    }
    if (!canCancel(row.status, actor)) {
      return {
        kind: 'conflict',
        code: 'not_allowed',
        currentStatus: row.status,
        message:
          row.status === 'DELIVERED'
            ? 'Order has already been delivered and cannot be cancelled'
            : `Order is ${row.status} and can no longer be cancelled`,
      };
    }

    const at = now().toISOString();
    const result = db
      .prepare(
        `UPDATE orders SET status = 'CANCELLED', cancellation_reason = ?, version = version + 1, updated_at = ?
          WHERE id = ? AND status = ?`,
      )
      .run(reason, at, id, row.status);
    if (result.changes !== 1) throw new Error(`lost update on order ${id}`);
    recordEvent(db, id, row.status, 'CANCELLED', actor, at);
    return { kind: 'done' };
  });

  if (outcome.kind !== 'done') return outcome;
  return { kind: 'ok', order: getOrder(db, id, actor)! };
}

/**
 * The order state machine. Pure and dependency-free: every rule about which
 * status may follow which, and who may cancel when, lives here, so the
 * database layer, the HTTP layer and the UIs all ask this module instead of
 * re-deriving the rules.
 *
 *   NOT_STARTED ─▶ STARTED ─▶ READY_FOR_PICKUP ─▶ DELIVERED
 *
 *   Cancel (─▶ CANCELLED):
 *     customer: only from NOT_STARTED
 *     kitchen:  from any status that is not yet final (not DELIVERED / CANCELLED)
 */

export const ORDER_STATUSES = ['NOT_STARTED', 'STARTED', 'READY_FOR_PICKUP', 'DELIVERED', 'CANCELLED'] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

/** Who is acting. Recorded on every status change. */
export type Actor = 'customer' | 'kitchen' | 'system';

const NEXT: Partial<Record<OrderStatus, OrderStatus>> = {
  NOT_STARTED: 'STARTED',
  STARTED: 'READY_FOR_PICKUP',
  READY_FOR_PICKUP: 'DELIVERED',
};

/** The single forward step from `status`, or null when there is none (terminal). */
export function nextStatus(status: OrderStatus): OrderStatus | null {
  return NEXT[status] ?? null;
}

export function isTerminal(status: OrderStatus): boolean {
  return status === 'DELIVERED' || status === 'CANCELLED';
}

/**
 * Whether `actor` may cancel an order in `status`. The customer is limited to
 * the window before the kitchen starts; the restaurant is not, but nobody can
 * cancel an order that is already delivered.
 */
export function canCancel(status: OrderStatus, actor: Actor): boolean {
  if (actor === 'customer') return status === 'NOT_STARTED';
  return !isTerminal(status);
}

export function isOrderStatus(value: unknown): value is OrderStatus {
  return typeof value === 'string' && (ORDER_STATUSES as readonly string[]).includes(value);
}

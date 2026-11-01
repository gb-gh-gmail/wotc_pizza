import type { FastifyInstance, FastifyReply } from 'fastify';
import type { DatabaseSync } from 'node:sqlite';
import type { OrderStatus } from './state.js';
import { placeOrder, type PlaceOutcome, type PlaceRequest } from './place.js';
import { updateOrder, type UpdateOutcome, type UpdateRequest } from './update.js';

interface Deps {
  db: DatabaseSync;
  now?: () => Date;
}

const KEY = /^[A-Za-z0-9_-]{8,100}$/;

/** What the page is showing, as a request body. The total and subtotal are required: without them there is nothing to confirm against. */
const submissionSchema = {
  menuToken: { type: 'string', minLength: 1, maxLength: 100 },
  // The order itself is checked by the pricing engine, which reports every problem.
  order: { type: 'object' },
  claimed: {
    type: 'object',
    required: ['totalCents', 'subtotalCents'],
    properties: { totalCents: { type: 'integer' }, subtotalCents: { type: 'integer' } },
  },
  confirmations: { type: 'object', properties: { largeTipCents: { type: 'integer' } } },
} as const;

/** Said to a customer whose order has moved past the point where it can be changed. */
const lockedMessage = (status: OrderStatus): string =>
  status === 'DELIVERED'
    ? 'Your order has already been delivered, so it can no longer be changed.'
    : status === 'READY_FOR_PICKUP'
      ? 'Your order is ready for pickup, so it can no longer be changed.'
      : 'The kitchen has already started your order, so it can no longer be changed.';

/** The answers that placing and changing an order share (everything except success). Returns null for any other outcome. */
function sendShared(reply: FastifyReply, outcome: PlaceOutcome | UpdateOutcome) {
  switch (outcome.kind) {
    case 'held':
      return reply.code(409).send({
        error: 'confirmation_required',
        message: 'Please review and confirm before we save your order',
        reasons: outcome.reasons,
        quote: outcome.quote,
        differences: outcome.differences,
        removedPromos: outcome.removedPromos,
        menuToken: outcome.menuToken,
        expiresAt: outcome.expiresAt,
      });
    case 'invalid_order':
      return reply.code(422).send({ error: 'invalid_order', message: 'Please fix the problems with your order', issues: outcome.issues });
    case 'menu_expired':
      return reply.code(409).send({
        error: 'menu_expired',
        message: 'Your session has timed out. Prices may have changed, so please reload the menu.',
        expiredAt: outcome.expiredAt,
      });
    case 'menu_unknown':
      return reply.code(409).send({ error: 'menu_unknown', message: 'These prices are no longer available. Please reload the menu.' });
    case 'idempotency_conflict':
      return reply.code(422).send({ error: 'idempotency_key_reused', message: 'That request key was already used for a different order' });
    default:
      return null;
  }
}

/** The customer sees an order without the kitchen's "what happens next". */
const forCustomer = <T extends { nextStatus: unknown }>(order: T): Omit<T, 'nextStatus'> => {
  const { nextStatus: _kitchenOnly, ...rest } = order;
  return rest;
};

function idempotencyKey(headers: Record<string, unknown>, reply: FastifyReply): string | null {
  const key = headers['idempotency-key'];
  if (typeof key === 'string' && KEY.test(key)) return key;
  reply.code(400).send({
    error: 'idempotency_key_required',
    message: 'An Idempotency-Key header (8 to 100 letters, digits, - or _) is required so a retry cannot be applied twice',
  });
  return null;
}

/** POST /orders places an order; PUT /orders/:id changes one that the kitchen has not started. */
export function registerOrders(app: FastifyInstance, { db, now = () => new Date() }: Deps): void {
  app.post<{ Body: Omit<PlaceRequest, 'idempotencyKey'> }>(
    '/orders',
    { schema: { body: { type: 'object', required: ['menuToken', 'order', 'claimed'], additionalProperties: false, properties: submissionSchema } } },
    async (req, reply) => {
      const key = idempotencyKey(req.headers, reply);
      if (!key) return reply;

      const outcome = placeOrder(db, { ...req.body, idempotencyKey: key }, now());
      if (outcome.kind === 'placed') {
        const order = forCustomer(outcome.order);
        return reply
          .code(outcome.replayed ? 200 : 201)
          .header('location', `/orders/${order.id}`)
          .send({ order, trackPath: `/track/${order.id}`, replayed: outcome.replayed });
      }
      return sendShared(reply, outcome);
    },
  );

  app.put<{ Params: { id: string }; Body: Omit<UpdateRequest, 'idempotencyKey' | 'orderId'> }>(
    '/orders/:id',
    {
      schema: {
        body: {
          type: 'object',
          required: ['menuToken', 'order', 'claimed', 'expectedVersion'],
          additionalProperties: false,
          properties: { ...submissionSchema, expectedVersion: { type: 'integer', minimum: 1 } },
        },
      },
    },
    async (req, reply) => {
      const key = idempotencyKey(req.headers, reply);
      if (!key) return reply;

      const outcome = updateOrder(db, { ...req.body, orderId: req.params.id, idempotencyKey: key }, now());
      switch (outcome.kind) {
        case 'updated': {
          const order = forCustomer(outcome.order);
          return reply.code(200).send({
            order,
            trackPath: `/track/${order.id}`,
            previousTotalCents: outcome.previousTotalCents,
            unchanged: outcome.unchanged,
            replayed: outcome.replayed,
          });
        }
        case 'not_found':
          return reply.code(404).send({ error: 'not_found', message: 'No such order' });
        case 'order_cancelled':
          return reply.code(409).send({ error: 'order_cancelled', message: 'This order has been cancelled, so it can no longer be changed.' });
        case 'order_locked':
          return reply.code(409).send({
            error: 'order_locked',
            message: lockedMessage(outcome.currentStatus),
            currentStatus: outcome.currentStatus,
          });
        case 'order_changed':
          return reply.code(409).send({
            error: 'order_changed',
            message: 'This order was changed somewhere else. Reload it to see the latest version before making changes.',
            order: forCustomer(outcome.order),
          });
        default:
          return sendShared(reply, outcome);
      }
    },
  );
}

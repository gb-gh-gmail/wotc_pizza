import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import type { DatabaseSync } from 'node:sqlite';
import { respond, cleanReason, reasonSchema } from '../orders/http.js';
import { advanceOrder, cancelOrder, listOrders } from '../orders/repo.js';
import { ORDER_STATUSES, type OrderStatus } from '../orders/state.js';

const UI_DIR = resolve(dirname(fileURLToPath(import.meta.url)), 'ui');

interface Deps {
  db: DatabaseSync;
  now?: () => Date;
}

/**
 * The restaurant side: a screen showing incoming orders, and the actions the
 * kitchen takes on them (advance to the next status, or cancel with a reason).
 */
export function registerKitchen(app: FastifyInstance, { db, now }: Deps): void {
  // Read once at start-up; a missing file fails fast rather than on first request.
  const page = readFileSync(resolve(UI_DIR, 'kitchen.html'), 'utf8');
  const script = readFileSync(resolve(UI_DIR, 'kitchen.js'), 'utf8');

  app.get('/kitchen', async (_req, reply) => reply.type('text/html; charset=utf-8').send(page));
  app.get('/kitchen/kitchen.js', async (_req, reply) => reply.type('text/javascript; charset=utf-8').send(script));

  app.get<{ Querystring: { include?: string } }>(
    '/kitchen/orders',
    { schema: { querystring: { type: 'object', properties: { include: { type: 'string', enum: ['closed'] } } } } },
    async (req) => ({ orders: listOrders(db, 'kitchen', { includeClosed: req.query.include === 'closed' }) }),
  );

  app.post<{ Params: { id: string }; Body: { expectedStatus: OrderStatus } }>(
    '/kitchen/orders/:id/advance',
    {
      schema: {
        body: {
          type: 'object',
          required: ['expectedStatus'],
          additionalProperties: false,
          properties: { expectedStatus: { type: 'string', enum: [...ORDER_STATUSES] } },
        },
      },
    },
    async (req, reply) => respond(reply, advanceOrder(db, req.params.id, req.body.expectedStatus, 'kitchen', now)),
  );

  // The kitchen may cancel at any status that is not yet final. The status is
  // re-checked at the moment of the request; `expectedStatus` is optional here.
  app.post<{ Params: { id: string }; Body: { reason?: string; expectedStatus?: OrderStatus } | undefined }>(
    '/kitchen/orders/:id/cancel',
    {
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          properties: { reason: reasonSchema, expectedStatus: { type: 'string', enum: [...ORDER_STATUSES] } },
        },
      },
    },
    async (req, reply) =>
      respond(
        reply,
        cancelOrder(
          db,
          req.params.id,
          { actor: 'kitchen', reason: cleanReason(req.body?.reason), expectedStatus: req.body?.expectedStatus },
          now,
        ),
      ),
  );
}

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import type { DatabaseSync } from 'node:sqlite';
import { cleanReason, reasonSchema, respond } from '../orders/http.js';
import { cancelOrder, getOrder, type OrderView } from '../orders/repo.js';
import { ORDER_STATUSES, type OrderStatus } from '../orders/state.js';

const UI_DIR = resolve(dirname(fileURLToPath(import.meta.url)), 'ui');

interface Deps {
  db: DatabaseSync;
  now?: () => Date;
}

/** The customer's view omits kitchen-only detail: customers cannot advance an order. */
const customerView = (o: object): object => {
  const { nextStatus: _kitchenOnly, ...rest } = o as OrderView;
  return rest;
};

/**
 * Customer-facing order endpoints: check status, and cancel while the order has
 * not been started. Cancelling is double-checked: the page sends the status it
 * last saw, and the service re-reads the real status when the request arrives.
 */
export function registerCustomer(app: FastifyInstance, { db, now }: Deps): void {
  const page = readFileSync(resolve(UI_DIR, 'track.html'), 'utf8');
  const script = readFileSync(resolve(UI_DIR, 'track.js'), 'utf8');

  // The page is the same for every order; the script reads the id from the URL.
  app.get('/track/:id', async (_req, reply) => reply.type('text/html; charset=utf-8').send(page));
  app.get('/track.js', async (_req, reply) => reply.type('text/javascript; charset=utf-8').send(script));

  app.get<{ Params: { id: string } }>('/orders/:id', async (req, reply) => {
    const order = getOrder(db, req.params.id, 'customer');
    if (!order) return reply.code(404).send({ error: 'not_found', message: 'No such order' });
    return { order: customerView(order) };
  });

  app.post<{ Params: { id: string }; Body: { reason?: string; expectedStatus?: OrderStatus } | undefined }>(
    '/orders/:id/cancel',
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
          { actor: 'customer', reason: cleanReason(req.body?.reason), expectedStatus: req.body?.expectedStatus },
          now,
        ),
        customerView,
      ),
  );
}

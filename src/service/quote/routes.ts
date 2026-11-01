import type { FastifyInstance } from 'fastify';
import type { DatabaseSync } from 'node:sqlite';
import { quoteOrder, type QuoteRequest } from './service.js';

interface Deps {
  db: DatabaseSync;
  now?: () => Date;
}

/**
 * POST /quote: what would this order cost, and does it match what I am showing?
 * Prices nothing permanently and creates nothing; it is safe to call on every change.
 */
export function registerQuote(app: FastifyInstance, { db, now = () => new Date() }: Deps): void {
  app.post<{ Body: QuoteRequest }>(
    '/quote',
    {
      schema: {
        body: {
          type: 'object',
          required: ['menuToken', 'order'],
          additionalProperties: false,
          properties: {
            menuToken: { type: 'string', minLength: 1, maxLength: 100 },
            // The shape of the order itself is checked by the pricing engine, which reports every problem.
            order: { type: 'object' },
            claimed: { type: 'object' },
          },
        },
      },
    },
    async (req, reply) => {
      const at = now();
      const outcome = quoteOrder(db, req.body, at);

      switch (outcome.kind) {
        case 'quote':
          return {
            quote: outcome.breakdown,
            matches: outcome.matches,
            differences: outcome.differences,
            menuToken: outcome.menuToken,
            expiresAt: outcome.expiresAt,
            serverTime: at.toISOString(),
          };
        case 'invalid_order':
          return reply.code(422).send({ error: 'invalid_order', message: 'Please fix the problems with your order', issues: outcome.issues });
        case 'menu_expired':
          return reply.code(409).send({
            error: 'menu_expired',
            message: 'Your session has timed out. Prices may have changed, so please reload the menu.',
            expiredAt: outcome.expiredAt,
            serverTime: at.toISOString(),
          });
        case 'menu_unknown':
          return reply.code(409).send({ error: 'menu_unknown', message: 'These prices are no longer available. Please reload the menu.' });
      }
    },
  );
}

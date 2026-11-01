import Fastify, { type FastifyBaseLogger, type FastifyInstance } from 'fastify';
import type { DatabaseSync } from 'node:sqlite';
import type { Logger } from '../lib/logger.js';
import { registerCustomer } from './customer/routes.js';
import { registerKitchen } from './kitchen/routes.js';

export interface AppDeps {
  db: DatabaseSync;
  logger?: Logger;
  /** Clock, injectable so tests can pin timestamps. */
  now?: () => Date;
}

/**
 * Build the HTTP app without starting it, so tests can drive it with `inject()`
 * and `main.ts` decides when to listen. Dependencies are passed in, never
 * created here, so the app owns nothing it would have to clean up.
 */
export function buildApp({ db, logger, now }: AppDeps): FastifyInstance {
  const app = Fastify({
    // A pino logger is a FastifyBaseLogger; naming that type keeps FastifyInstance's default generics.
    ...(logger ? { loggerInstance: logger as FastifyBaseLogger } : { logger: false }),
    // On close, drop idle keep-alive connections so shutdown isn't held open by them.
    forceCloseConnections: 'idle',
  });

  // Readiness: 200 only if the database answers. Orchestrators use this to hold traffic.
  app.get('/health', async (_req, reply) => {
    try {
      db.prepare('SELECT 1').get();
      return { status: 'ok', db: 'ok' };
    } catch (err) {
      app.log.error({ err }, 'health check: database unavailable');
      return reply.code(503).send({ status: 'unavailable', db: 'error' });
    }
  });

  registerKitchen(app, { db, now });
  registerCustomer(app, { db, now });

  return app;
}

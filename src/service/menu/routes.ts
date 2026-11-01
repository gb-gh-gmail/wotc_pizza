import type { FastifyInstance } from 'fastify';
import type { DatabaseSync } from 'node:sqlite';
import { SettingsError } from '../settings.js';
import { MenuConfigError } from './repo.js';
import { getOrCreateSnapshot } from './snapshots.js';

interface Deps {
  db: DatabaseSync;
  now?: () => Date;
}

export function registerMenu(app: FastifyInstance, { db, now = () => new Date() }: Deps): void {
  // The menu a customer can order from right now, with every price resolved. The prices are
  // also recorded as a snapshot: the order is later verified against this snapshot, so a
  // price change made after this response cannot change what the customer is charged.
  app.get('/menu', async (_req, reply) => {
    try {
      const at = now();
      const snapshot = getOrCreateSnapshot(db, at);
      if (!snapshot) return reply.code(503).send({ error: 'no_active_menu', message: 'There is no menu available right now' });
      return {
        ...snapshot.data,
        menuToken: snapshot.token,
        // The deadline for completing an order with these prices, and the server's clock, so the
        // page can count down against the server's time even if the customer's device clock is wrong.
        expiresAt: snapshot.expiresAt,
        serverTime: at.toISOString(),
      };
    } catch (err) {
      if (err instanceof MenuConfigError || err instanceof SettingsError) {
        app.log.error({ err }, 'menu is misconfigured');
        return reply.code(503).send({ error: 'menu_misconfigured', message: 'The menu is temporarily unavailable' });
      }
      throw err;
    }
  });
}

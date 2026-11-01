import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify, { type FastifyBaseLogger, type FastifyInstance } from 'fastify';
import { NO_CACHE, pageFile } from '../lib/files.js';
import type { Logger } from '../lib/logger.js';

const UI_DIR = resolve(dirname(fileURLToPath(import.meta.url)), 'ui');

export interface BuilderDeps {
  orderServiceUrl: string;
  timeoutMs?: number;
  logger?: Logger;
  /** Injectable for tests; defaults to the global fetch. */
  fetchImpl?: typeof fetch;
  /** Re-read the page files on every request (development), instead of serving the start-up copy. */
  reloadUi?: boolean;
}

// Request headers worth forwarding to the order service. Anything else stays here.
const FORWARDED_HEADERS = ['content-type', 'idempotency-key'] as const;

/**
 * The order builder: serves the customer's web page and relays `/api/*` to the
 * order service. It is a separate process from the order service and talks to
 * it over HTTP only. It has no database and no business rules of its own.
 */
export function buildBuilderApp({ orderServiceUrl, timeoutMs = 8000, logger, fetchImpl = fetch, reloadUi = false }: BuilderDeps): FastifyInstance {
  const app = Fastify({
    ...(logger ? { loggerInstance: logger as FastifyBaseLogger } : { logger: false }),
    forceCloseConnections: 'idle',
  });

  // The page and its scripts. A missing file fails at start-up; in development they are re-read on every
  // request so an edit shows up without a restart. logic.js holds the page's decisions (no DOM) and is
  // shared with the tests.
  const page = pageFile(resolve(UI_DIR, 'index.html'), reloadUi);
  const sendPage = async (_req: unknown, reply: import('fastify').FastifyReply) =>
    reply.header('cache-control', NO_CACHE).type('text/html; charset=utf-8').send(page());
  app.get('/', sendPage); // building a new order
  app.get('/change/:id', sendPage); // changing an existing one: the same page, which finds the order from the address
  for (const file of ['app.js', 'logic.js']) {
    const script = pageFile(resolve(UI_DIR, file), reloadUi);
    app.get(`/${file}`, async (_req, reply) => reply.header('cache-control', NO_CACHE).type('text/javascript; charset=utf-8').send(script()));
  }

  app.get('/health', async () => ({ status: 'ok' }));
  app.get('/favicon.ico', async (_req, reply) => reply.code(204).send()); // there is no icon; say so quietly instead of a 404 in the console

  // Relay to the order service. The browser only ever talks to this origin.
  //   /api/*                 the builder page's calls (the /api prefix is dropped)
  //   /track/:id, /track.js  the order status page, which the order service serves
  //   /orders/*              that page's calls: check the status, cancel
  // Nothing else is relayed: in particular, not the kitchen screen.
  const relayed = [
    { url: '/api/*', strip: '/api'.length },
    { url: '/track/*', strip: 0 },
    { url: '/track.js', strip: 0 },
    { url: '/orders/*', strip: 0 },
  ];
  for (const { url, strip } of relayed) {
    app.route({
      method: ['GET', 'POST', 'PUT', 'DELETE'],
      url,
      handler: async (req, reply) => {
        const target = `${orderServiceUrl}${req.url.slice(strip)}`;

        const headers: Record<string, string> = {};
        for (const name of FORWARDED_HEADERS) {
          const value = req.headers[name];
          if (typeof value === 'string') headers[name] = value;
        }
        const hasBody = req.method !== 'GET' && req.body !== undefined && req.body !== null;

        try {
          const upstream = await fetchImpl(target, {
            method: req.method,
            headers,
            body: hasBody ? JSON.stringify(req.body) : undefined,
            signal: AbortSignal.timeout(timeoutMs),
          });
          return reply
            .code(upstream.status)
            .type(upstream.headers.get('content-type') ?? 'application/json')
            .send(await upstream.text());
        } catch (err) {
          const timedOut = err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError');
          req.log.warn({ err, target }, timedOut ? 'order service timed out' : 'order service unreachable');
          return reply.code(timedOut ? 504 : 502).send({
            error: timedOut ? 'order_service_timeout' : 'order_service_unavailable',
            message: timedOut
              ? 'The restaurant took too long to respond. Please try again.'
              : 'Cannot reach the restaurant right now. Please try again.',
          });
        }
      },
    });
  }

  return app;
}

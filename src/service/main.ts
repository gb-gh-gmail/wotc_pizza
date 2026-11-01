import { createLifecycle } from '../lib/lifecycle.js';
import { createLogger } from '../lib/logger.js';
import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { openDatabase } from './db.js';
import { purgeExpiredSnapshots } from './menu/snapshots.js';

const config = loadConfig();
const logger = createLogger({ name: 'order-service', level: config.logLevel, pretty: config.logPretty });

const lifecycle = createLifecycle({ logger, timeoutMs: config.shutdownTimeoutMs });
lifecycle.install();

try {
  // Start-up order matters: hooks run in reverse, so the HTTP server (registered last)
  // stops accepting requests before the database it uses is closed.
  const db = openDatabase({ path: config.dbPath, seed: config.seedDb, logger });
  lifecycle.onShutdown('database', () => db.close());

  // Housekeeping: drop expired menu snapshots that no order refers to.
  const purged = purgeExpiredSnapshots(db, new Date());
  if (purged > 0) logger.info(`removed ${purged} expired menu snapshot(s)`);

  const app = buildApp({ db, logger, reloadUi: config.uiReload });
  lifecycle.onShutdown('http server', () => app.close());

  await app.listen({ host: config.host, port: config.port });
} catch (err) {
  logger.fatal({ err }, 'failed to start');
  await lifecycle.shutdown('startup failure', 1);
}

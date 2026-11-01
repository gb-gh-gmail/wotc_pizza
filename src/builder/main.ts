import { createLifecycle } from '../lib/lifecycle.js';
import { createLogger } from '../lib/logger.js';
import { buildBuilderApp } from './app.js';
import { loadBuilderConfig } from './config.js';

const config = loadBuilderConfig();
const logger = createLogger({ name: 'order-builder', level: config.logLevel, pretty: config.logPretty });

const lifecycle = createLifecycle({ logger, timeoutMs: config.shutdownTimeoutMs });
lifecycle.install();

try {
  const app = buildBuilderApp({
    orderServiceUrl: config.orderServiceUrl,
    timeoutMs: config.orderServiceTimeoutMs,
    logger,
    reloadUi: config.uiReload,
  });
  lifecycle.onShutdown('http server', () => app.close());

  await app.listen({ host: config.host, port: config.port });
  logger.info(`relaying /api/* to ${config.orderServiceUrl}`);
} catch (err) {
  logger.fatal({ err }, 'failed to start');
  await lifecycle.shutdown('startup failure', 1);
}

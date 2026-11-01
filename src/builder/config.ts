import { intFrom } from '../lib/env.js';
import { parseLogLevel, type LogLevel } from '../lib/logger.js';

export interface BuilderConfig {
  host: string;
  port: number;
  /** Base URL of the order service this builder talks to, with no trailing slash. */
  orderServiceUrl: string;
  /** How long to wait for the order service before giving up with a 504. */
  orderServiceTimeoutMs: number;
  shutdownTimeoutMs: number;
  logLevel: LogLevel;
  logPretty: boolean;
  /** Re-read the page files on every request (development), instead of serving the start-up copy. */
  uiReload: boolean;
}

/**
 * Builder settings use a BUILDER_ prefix for host/port because the order
 * service already owns HOST/PORT, and both read the same dev env file.
 */
export function loadBuilderConfig(env: NodeJS.ProcessEnv = process.env): BuilderConfig {
  return {
    host: env.BUILDER_HOST ?? '127.0.0.1',
    port: intFrom(env.BUILDER_PORT, 3000, 'BUILDER_PORT'),
    orderServiceUrl: (env.ORDER_SERVICE_URL || 'http://127.0.0.1:3001').replace(/\/+$/, ''),
    orderServiceTimeoutMs: intFrom(env.ORDER_SERVICE_TIMEOUT_MS, 8000, 'ORDER_SERVICE_TIMEOUT_MS'),
    shutdownTimeoutMs: intFrom(env.SHUTDOWN_TIMEOUT_MS, 10_000, 'SHUTDOWN_TIMEOUT_MS'),
    logLevel: parseLogLevel(env.LOG_LEVEL),
    logPretty: env.LOG_PRETTY === 'true',
    // On unless explicitly turned off: serving a stale page costs far more than re-reading a small file.
    uiReload: env.UI_RELOAD !== 'false',
  };
}

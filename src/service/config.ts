import { parseLogLevel, type LogLevel } from '../lib/logger.js';

export interface ServiceConfig {
  host: string;
  port: number;
  shutdownTimeoutMs: number;
  logLevel: LogLevel;
  logPretty: boolean;
  /** SQLite file path, or ':memory:'. */
  dbPath: string;
  /** Load the demo menu/promos/tax into an empty database on start-up. */
  seedDb: boolean;
}

/** Read configuration from the environment, with safe local defaults. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServiceConfig {
  return {
    // Loopback by default; containers set HOST=0.0.0.0.
    host: env.HOST ?? '127.0.0.1',
    port: intFrom(env.PORT, 3001, 'PORT'),
    shutdownTimeoutMs: intFrom(env.SHUTDOWN_TIMEOUT_MS, 10_000, 'SHUTDOWN_TIMEOUT_MS'),
    logLevel: parseLogLevel(env.LOG_LEVEL),
    logPretty: env.LOG_PRETTY === 'true',
    dbPath: env.DB_PATH || 'data/orders.db',
    seedDb: env.SEED_DB === 'true',
  };
}

function intFrom(raw: string | undefined, fallback: number, name: string): number {
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) {
    throw new Error(`${name} must be a non-negative integer, got "${raw}"`);
  }
  return n;
}

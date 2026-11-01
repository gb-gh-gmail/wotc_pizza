import { pino, type Logger as PinoLogger } from 'pino';

/**
 * Standard severity levels, lowest to highest. A logger emits its level and
 * everything above it; 'silent' turns logging off (used by tests).
 */
export const LOG_LEVELS = ['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'silent'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

export type Logger = PinoLogger;

export interface LoggerOptions {
  /** Name added to every line, e.g. 'order-service'. */
  name: string;
  level?: LogLevel;
  /** Human-readable output for local development (needs pino-pretty). */
  pretty?: boolean;
}

export function createLogger(options: LoggerOptions): Logger {
  return pino({
    name: options.name,
    level: options.level ?? 'info',
    // Never write secrets or customer detail even if a request object is logged.
    redact: ['req.headers.authorization', 'req.headers.cookie'],
    ...(options.pretty
      ? { transport: { target: 'pino-pretty', options: { colorize: true, translateTime: 'SYS:HH:MM:ss.l' } } }
      : {}),
  });
}

/** Parse LOG_LEVEL, failing loudly on a typo rather than silently logging at the wrong level. */
export function parseLogLevel(raw: string | undefined, fallback: LogLevel = 'info'): LogLevel {
  if (raw === undefined || raw === '') return fallback;
  const level = raw.toLowerCase();
  if ((LOG_LEVELS as readonly string[]).includes(level)) return level as LogLevel;
  throw new Error(`LOG_LEVEL must be one of ${LOG_LEVELS.join(', ')}, got "${raw}"`);
}

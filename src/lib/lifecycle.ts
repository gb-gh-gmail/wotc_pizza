/**
 * Process lifecycle: one place that owns shutdown.
 *
 * Every way a process can be asked to stop (SIGINT, SIGTERM, SIGHUP, SIGBREAK,
 * an uncaught exception, a failed start-up) funnels into the single `shutdown()`
 * function, so cleanup is written once and always runs the same way:
 *   - hooks run in reverse registration order (last opened, first closed),
 *   - a failing hook never prevents the remaining hooks from running,
 *   - a repeated request while shutting down is ignored (same promise returned),
 *   - a hard timeout guarantees the process exits even if a hook hangs.
 */

/** The slice of a logger the lifecycle needs; a pino logger satisfies it. */
export interface Logger {
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
  fatal(msg: string): void;
}

export type ShutdownHook = () => void | Promise<void>;

export type Signal = 'SIGINT' | 'SIGTERM' | 'SIGHUP' | 'SIGBREAK';

/** SIGBREAK is Ctrl+Break on Windows consoles; it does not exist elsewhere. */
export const DEFAULT_SIGNALS: readonly Signal[] =
  process.platform === 'win32'
    ? ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK']
    : ['SIGINT', 'SIGTERM', 'SIGHUP'];

/** The slice of `process` we use, so tests can substitute a fake. */
export interface ProcessLike {
  on(event: string, listener: (...args: any[]) => void): unknown;
  off(event: string, listener: (...args: any[]) => void): unknown;
  exit(code?: number): unknown;
}

export interface LifecycleOptions {
  logger: Logger;
  /** Max time for all hooks to finish before forcing exit. Default 10s. */
  timeoutMs?: number;
  proc?: ProcessLike;
  signals?: readonly Signal[];
}

export interface Lifecycle {
  /** Register cleanup. Hooks run in reverse order of registration. */
  onShutdown(name: string, hook: ShutdownHook): void;
  /** Run cleanup once, then exit. Safe to call repeatedly. */
  shutdown(reason: string, exitCode?: number): Promise<void>;
  /** Route signals and fatal errors into `shutdown`. Returns an uninstall function. */
  install(): () => void;
  readonly isShuttingDown: boolean;
}

export function createLifecycle(options: LifecycleOptions): Lifecycle {
  const { logger } = options;
  const timeoutMs = options.timeoutMs ?? 10_000;
  const proc: ProcessLike = options.proc ?? process;
  const signals = options.signals ?? DEFAULT_SIGNALS;

  const hooks: { name: string; hook: ShutdownHook }[] = [];
  let inFlight: Promise<void> | undefined;

  async function runHooks(): Promise<boolean> {
    let ok = true;
    for (const { name, hook } of [...hooks].reverse()) {
      try {
        logger.info(`shutdown: ${name}`);
        await hook();
      } catch (err) {
        ok = false;
        logger.error(`shutdown hook "${name}" failed: ${describe(err)}`);
      }
    }
    return ok;
  }

  function shutdown(reason: string, exitCode = 0): Promise<void> {
    if (inFlight) {
      logger.warn(`shutdown already in progress, ignoring: ${reason}`);
      return inFlight;
    }
    logger.info(`shutting down (${reason})`);

    inFlight = (async () => {
      let code = exitCode;
      let timer: NodeJS.Timeout | undefined;
      const timedOut = new Promise<'timeout'>((resolve) => {
        timer = setTimeout(() => resolve('timeout'), timeoutMs);
      });
      try {
        const result = await Promise.race([runHooks(), timedOut]);
        if (result === 'timeout') {
          logger.error(`shutdown did not finish within ${timeoutMs}ms, forcing exit`);
          code = 1;
        } else if (result === false) {
          code = 1;
        }
      } finally {
        clearTimeout(timer);
      }
      proc.exit(code);
    })();
    return inFlight;
  }

  function install(): () => void {
    const registered: [string, (...args: any[]) => void][] = [];
    const add = (event: string, listener: (...args: any[]) => void) => {
      proc.on(event, listener);
      registered.push([event, listener]);
    };

    for (const signal of signals) {
      add(signal, () => void shutdown(signal));
    }
    add('uncaughtException', (err: unknown) => {
      logger.fatal(`uncaught exception: ${describe(err)}`);
      void shutdown('uncaughtException', 1);
    });
    add('unhandledRejection', (err: unknown) => {
      logger.fatal(`unhandled rejection: ${describe(err)}`);
      void shutdown('unhandledRejection', 1);
    });

    return () => {
      for (const [event, listener] of registered) proc.off(event, listener);
    };
  }

  return {
    onShutdown(name, hook) {
      hooks.push({ name, hook });
    },
    shutdown,
    install,
    get isShuttingDown() {
      return inFlight !== undefined;
    },
  };
}

function describe(err: unknown): string {
  return err instanceof Error ? (err.stack ?? err.message) : String(err);
}

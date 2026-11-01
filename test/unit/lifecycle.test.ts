import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createLifecycle, type ProcessLike } from '../../src/lib/lifecycle.js';

class FakeProcess extends EventEmitter implements ProcessLike {
  exitCodes: number[] = [];
  exit(code = 0) {
    this.exitCodes.push(code);
  }
}

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() };

function setup(timeoutMs?: number) {
  const proc = new FakeProcess();
  const lifecycle = createLifecycle({ logger, proc, timeoutMs, signals: ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK'] });
  return { proc, lifecycle };
}

beforeEach(() => vi.clearAllMocks());
afterEach(() => vi.useRealTimers());

describe('lifecycle shutdown', () => {
  it('runs hooks in reverse registration order, then exits 0', async () => {
    const { proc, lifecycle } = setup();
    const order: string[] = [];
    lifecycle.onShutdown('database', () => void order.push('database'));
    lifecycle.onShutdown('http', async () => void order.push('http'));

    await lifecycle.shutdown('test');

    expect(order).toEqual(['http', 'database']);
    expect(proc.exitCodes).toEqual([0]);
  });

  it('keeps running remaining hooks when one fails, and exits 1', async () => {
    const { proc, lifecycle } = setup();
    const ran: string[] = [];
    lifecycle.onShutdown('first', () => void ran.push('first'));
    lifecycle.onShutdown('broken', () => {
      throw new Error('boom');
    });
    lifecycle.onShutdown('last', () => void ran.push('last'));

    await lifecycle.shutdown('test');

    expect(ran).toEqual(['last', 'first']);
    expect(proc.exitCodes).toEqual([1]);
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('"broken" failed'));
  });

  it('is idempotent: repeated requests run hooks and exit once', async () => {
    const { proc, lifecycle } = setup();
    const hook = vi.fn();
    lifecycle.onShutdown('once', hook);

    await Promise.all([lifecycle.shutdown('a'), lifecycle.shutdown('b'), lifecycle.shutdown('c')]);

    expect(hook).toHaveBeenCalledTimes(1);
    expect(proc.exitCodes).toEqual([0]);
    expect(lifecycle.isShuttingDown).toBe(true);
  });

  it('keeps the first requested exit code', async () => {
    const { proc, lifecycle } = setup();
    await Promise.all([lifecycle.shutdown('fatal', 1), lifecycle.shutdown('signal', 0)]);
    expect(proc.exitCodes).toEqual([1]);
  });

  it('forces exit 1 if a hook hangs past the timeout', async () => {
    vi.useFakeTimers();
    const { proc, lifecycle } = setup(1000);
    lifecycle.onShutdown('hangs', () => new Promise<void>(() => {}));

    const done = lifecycle.shutdown('test');
    await vi.advanceTimersByTimeAsync(1000);
    await done;

    expect(proc.exitCodes).toEqual([1]);
  });
});

describe('lifecycle.install', () => {
  it.each(['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK'])('%s goes through common shutdown with exit 0', async (signal) => {
    const { proc, lifecycle } = setup();
    const hook = vi.fn();
    lifecycle.onShutdown('cleanup', hook);
    lifecycle.install();

    proc.emit(signal);
    await vi.waitFor(() => expect(proc.exitCodes).toEqual([0]));

    expect(hook).toHaveBeenCalledTimes(1);
  });

  it.each(['uncaughtException', 'unhandledRejection'])('%s runs cleanup and exits 1', async (event) => {
    const { proc, lifecycle } = setup();
    const hook = vi.fn();
    lifecycle.onShutdown('cleanup', hook);
    lifecycle.install();

    proc.emit(event, new Error('bad'));
    await vi.waitFor(() => expect(proc.exitCodes).toEqual([1]));

    expect(hook).toHaveBeenCalledTimes(1);
  });

  it('several different signals still shut down only once', async () => {
    const { proc, lifecycle } = setup();
    const hook = vi.fn();
    lifecycle.onShutdown('cleanup', hook);
    lifecycle.install();

    proc.emit('SIGTERM');
    proc.emit('SIGHUP');
    proc.emit('SIGINT');
    await vi.waitFor(() => expect(proc.exitCodes.length).toBe(1));

    expect(hook).toHaveBeenCalledTimes(1);
  });

  it('uninstall removes every listener', () => {
    const { proc, lifecycle } = setup();
    const uninstall = lifecycle.install();
    expect(proc.eventNames().length).toBeGreaterThan(0);
    uninstall();
    expect(proc.eventNames()).toEqual([]);
  });
});

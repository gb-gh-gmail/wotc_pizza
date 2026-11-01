import { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { LOG_LEVELS, parseLogLevel } from '../../src/lib/logger.js';
import { pino } from 'pino';

describe('parseLogLevel', () => {
  it('defaults to info when unset or empty', () => {
    expect(parseLogLevel(undefined)).toBe('info');
    expect(parseLogLevel('')).toBe('info');
  });

  it.each(LOG_LEVELS)('accepts %s, case-insensitively', (level) => {
    expect(parseLogLevel(level.toUpperCase())).toBe(level);
  });

  it('rejects an unknown level instead of guessing', () => {
    expect(() => parseLogLevel('verbose')).toThrow(/LOG_LEVEL/);
  });
});

describe('level filtering', () => {
  function capture(level: string) {
    const lines: string[] = [];
    const sink = new Writable({
      write(chunk, _enc, cb) {
        lines.push(chunk.toString());
        cb();
      },
    });
    const log = pino({ level }, sink);
    log.trace('t');
    log.debug('d');
    log.info('i');
    log.warn('w');
    log.error('e');
    log.fatal('f');
    return lines.map((l) => JSON.parse(l).msg);
  }

  it('emits the configured level and everything above it', () => {
    expect(capture('warn')).toEqual(['w', 'e', 'f']);
    expect(capture('info')).toEqual(['i', 'w', 'e', 'f']);
  });

  it('silent emits nothing', () => {
    expect(capture('silent')).toEqual([]);
  });
});

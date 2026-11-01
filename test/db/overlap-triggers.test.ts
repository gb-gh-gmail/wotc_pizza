import { beforeEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../../src/service/db.js';

const NOW = '2026-01-01T00:00:00.000Z';
const OVERLAP = /overlapping effective windows/;

describe('menus: active windows may not overlap', () => {
  let db: ReturnType<typeof openDatabase>;
  const add = (name: string, active: 0 | 1, from: string, to: string | null) =>
    db
      .prepare(
        `INSERT INTO menus (name, active, effective_from, effective_to, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(name, active, from, to, NOW, NOW);

  beforeEach(() => {
    db = openDatabase({ path: ':memory:' });
    add('A', 1, '2026-01-01T00:00:00.000Z', '2026-06-01T00:00:00.000Z');
  });

  it('rejects an overlapping active window', () => {
    expect(() => add('B', 1, '2026-05-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z')).toThrow(OVERLAP);
  });

  it('allows back-to-back windows (half-open)', () => {
    expect(() => add('C', 1, '2026-06-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z')).not.toThrow();
  });

  it('allows an overlapping INACTIVE menu', () => {
    expect(() => add('D', 0, '2026-02-01T00:00:00.000Z', null)).not.toThrow();
  });

  it('rejects an open-ended window that runs into a later menu', () => {
    add('C', 1, '2026-06-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z');
    expect(() => add('E', 1, '2026-08-01T00:00:00.000Z', null)).toThrow(OVERLAP);
  });

  it('rejects reactivating a menu whose window overlaps an active one', () => {
    add('D', 0, '2026-02-01T00:00:00.000Z', null);
    expect(() => db.exec(`UPDATE menus SET active = 1 WHERE name = 'D'`)).toThrow(OVERLAP);
  });

  it('rejects extending a window into its neighbour', () => {
    add('C', 1, '2026-06-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z');
    expect(() => db.exec(`UPDATE menus SET effective_to = '2026-07-01T00:00:00.000Z' WHERE name = 'A'`)).toThrow(OVERLAP);
  });

  it('allows editing a menu without touching its window', () => {
    expect(() => db.exec(`UPDATE menus SET name = 'A2' WHERE name = 'A'`)).not.toThrow();
  });
});

describe('window timestamps must be in one canonical form', () => {
  // Windows are compared as text, so '...00Z' vs '...00.000Z' would silently mis-order at
  // second boundaries. The schema refuses anything but YYYY-MM-DDTHH:MM:SS.sssZ.
  const db = openDatabase({ path: ':memory:' });
  const insertMenu = (from: string, to: string | null) =>
    db
      .prepare(`INSERT INTO menus (name, effective_from, effective_to, created_at, updated_at) VALUES ('m', ?, ?, ?, ?)`)
      .run(from, to, NOW, NOW);

  it.each([
    ['no milliseconds', '2026-01-01T00:00:00Z'],
    ['a UTC offset instead of Z', '2026-01-01T00:00:00.000+00:00'],
    ['a date only', '2026-01-01'],
    ['a space instead of T', '2026-01-01 00:00:00.000Z'],
  ])('rejects %s', (_label, bad) => {
    expect(() => insertMenu(bad, null)).toThrow(/CHECK/i);
    expect(() => insertMenu('2026-01-01T00:00:00.000Z', bad)).toThrow(/CHECK/i);
  });

  it('accepts exactly what Date.toISOString() produces', () => {
    expect(() => insertMenu(new Date('2030-05-06T07:08:09.123Z').toISOString(), null)).not.toThrow();
  });

  it('applies to prices, tax rates and promos too', () => {
    expect(() => db.exec(`INSERT INTO tax_rates (name, rate_bps, effective_from, created_at, updated_at) VALUES ('t', 1, '2026-01-01', '${NOW}', '${NOW}')`)).toThrow(/CHECK/i);
    expect(() => db.exec(`INSERT INTO promos (code, kind, starts_at, created_at, updated_at) VALUES ('X', 'flat_off', '2026-01-01', '${NOW}', '${NOW}')`)).toThrow(/CHECK/i);
  });
});

describe('tax_rates: windows may not overlap', () => {
  let db: ReturnType<typeof openDatabase>;
  const add = (from: string, to: string | null) =>
    db
      .prepare(
        `INSERT INTO tax_rates (name, rate_bps, effective_from, effective_to, created_at, updated_at) VALUES ('t', 650, ?, ?, ?, ?)`,
      )
      .run(from, to, NOW, NOW);

  beforeEach(() => {
    db = openDatabase({ path: ':memory:' });
    add('2026-01-01T00:00:00.000Z', '2026-07-01T00:00:00.000Z');
  });

  it('rejects an overlapping window', () => {
    expect(() => add('2026-06-01T00:00:00.000Z', null)).toThrow(OVERLAP);
  });

  it('allows a back-to-back open-ended window', () => {
    expect(() => add('2026-07-01T00:00:00.000Z', null)).not.toThrow();
  });

  it('allows a window that ends exactly where the existing one starts', () => {
    expect(() => add('2025-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')).not.toThrow();
  });

  it('rejects an open-ended window that swallows an existing one', () => {
    expect(() => add('2025-06-01T00:00:00.000Z', null)).toThrow(OVERLAP);
  });

  it('rejects extending a window into its neighbour', () => {
    add('2026-07-01T00:00:00.000Z', null);
    expect(() => db.exec(`UPDATE tax_rates SET effective_to = '2026-08-01T00:00:00.000Z' WHERE effective_from = '2026-01-01T00:00:00.000Z'`)).toThrow(OVERLAP);
  });

  it('allows changing the rate without touching the window', () => {
    expect(() => db.exec(`UPDATE tax_rates SET rate_bps = 700 WHERE effective_from = '2026-01-01T00:00:00.000Z'`)).not.toThrow();
  });
});

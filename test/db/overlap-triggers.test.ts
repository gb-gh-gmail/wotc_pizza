import { beforeEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../../src/service/db.js';

const NOW = '2026-01-01T00:00:00Z';
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
    add('A', 1, '2026-01-01T00:00:00Z', '2026-06-01T00:00:00Z');
  });

  it('rejects an overlapping active window', () => {
    expect(() => add('B', 1, '2026-05-01T00:00:00Z', '2026-09-01T00:00:00Z')).toThrow(OVERLAP);
  });

  it('allows back-to-back windows (half-open)', () => {
    expect(() => add('C', 1, '2026-06-01T00:00:00Z', '2026-09-01T00:00:00Z')).not.toThrow();
  });

  it('allows an overlapping INACTIVE menu', () => {
    expect(() => add('D', 0, '2026-02-01T00:00:00Z', null)).not.toThrow();
  });

  it('rejects an open-ended window that runs into a later menu', () => {
    add('C', 1, '2026-06-01T00:00:00Z', '2026-09-01T00:00:00Z');
    expect(() => add('E', 1, '2026-08-01T00:00:00Z', null)).toThrow(OVERLAP);
  });

  it('rejects reactivating a menu whose window overlaps an active one', () => {
    add('D', 0, '2026-02-01T00:00:00Z', null);
    expect(() => db.exec(`UPDATE menus SET active = 1 WHERE name = 'D'`)).toThrow(OVERLAP);
  });

  it('rejects extending a window into its neighbour', () => {
    add('C', 1, '2026-06-01T00:00:00Z', '2026-09-01T00:00:00Z');
    expect(() => db.exec(`UPDATE menus SET effective_to = '2026-07-01T00:00:00Z' WHERE name = 'A'`)).toThrow(OVERLAP);
  });

  it('allows editing a menu without touching its window', () => {
    expect(() => db.exec(`UPDATE menus SET name = 'A2' WHERE name = 'A'`)).not.toThrow();
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
    add('2026-01-01T00:00:00Z', '2026-07-01T00:00:00Z');
  });

  it('rejects an overlapping window', () => {
    expect(() => add('2026-06-01T00:00:00Z', null)).toThrow(OVERLAP);
  });

  it('allows a back-to-back open-ended window', () => {
    expect(() => add('2026-07-01T00:00:00Z', null)).not.toThrow();
  });

  it('allows a window that ends exactly where the existing one starts', () => {
    expect(() => add('2025-01-01T00:00:00Z', '2026-01-01T00:00:00Z')).not.toThrow();
  });

  it('rejects an open-ended window that swallows an existing one', () => {
    expect(() => add('2025-06-01T00:00:00Z', null)).toThrow(OVERLAP);
  });

  it('rejects extending a window into its neighbour', () => {
    add('2026-07-01T00:00:00Z', null);
    expect(() => db.exec(`UPDATE tax_rates SET effective_to = '2026-08-01T00:00:00Z' WHERE effective_from = '2026-01-01T00:00:00Z'`)).toThrow(OVERLAP);
  });

  it('allows changing the rate without touching the window', () => {
    expect(() => db.exec(`UPDATE tax_rates SET rate_bps = 700 WHERE effective_from = '2026-01-01T00:00:00Z'`)).not.toThrow();
  });
});

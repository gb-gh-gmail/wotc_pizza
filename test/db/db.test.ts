import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase, runInTransaction, SCHEMA_VERSION } from '../../src/service/db.js';

const count = (db: ReturnType<typeof openDatabase>, table: string) =>
  (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;

describe('openDatabase', () => {
  it('creates the schema and records its version', () => {
    const db = openDatabase({ path: ':memory:' });
    const { user_version } = db.prepare('PRAGMA user_version').get() as { user_version: number };
    expect(user_version).toBe(SCHEMA_VERSION);
    expect(count(db, 'orders')).toBe(0);
    db.close();
  });

  it('enforces foreign keys', () => {
    const db = openDatabase({ path: ':memory:' });
    expect(() =>
      db
        .prepare(
          `INSERT INTO order_status_events (order_id, to_status, actor, at) VALUES ('nope', 'STARTED', 'kitchen', 'x')`,
        )
        .run(),
    ).toThrow(/FOREIGN KEY/i);
    db.close();
  });

  it('does not seed unless asked', () => {
    const db = openDatabase({ path: ':memory:' });
    expect(count(db, 'menus')).toBe(0);
    db.close();
  });

  it('seeds the standard menu, promos and tax rate', () => {
    const db = openDatabase({ path: ':memory:', seed: true });
    expect(count(db, 'menus')).toBe(1);
    expect(count(db, 'menu_items')).toBe(15);
    expect(count(db, 'prices')).toBe(15);
    expect(count(db, 'promos')).toBe(2);
    expect(count(db, 'tax_rates')).toBe(1);
    db.close();
  });

  it('every seeded menu item has exactly one price', () => {
    const db = openDatabase({ path: ':memory:', seed: true });
    const bad = db
      .prepare(
        `SELECT i.code FROM menu_items i LEFT JOIN prices p ON p.menu_item_id = i.id
         GROUP BY i.id HAVING COUNT(p.id) <> 1`,
      )
      .all();
    expect(bad).toEqual([]);
    db.close();
  });
});

describe('persistence across restarts', () => {
  let dir: string | undefined;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it('reopening an existing file keeps data and does not re-seed or re-apply the schema', () => {
    dir = mkdtempSync(join(tmpdir(), 'pizza-db-'));
    const path = join(dir, 'nested', 'orders.db'); // parent directory must be created for us

    const first = openDatabase({ path, seed: true });
    first.close();

    const second = openDatabase({ path, seed: true });
    expect(count(second, 'menus')).toBe(1);
    expect(count(second, 'menu_items')).toBe(15);
    second.close();
  });

  it('refuses a database written by a newer build', () => {
    dir = mkdtempSync(join(tmpdir(), 'pizza-db-'));
    const path = join(dir, 'orders.db');
    const db = openDatabase({ path });
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION + 1}`);
    db.close();

    expect(() => openDatabase({ path })).toThrow(/newer than this build/);
  });
});

describe('runInTransaction', () => {
  it('commits on success and rolls everything back on failure', () => {
    const db = openDatabase({ path: ':memory:', seed: true });
    const addCategory = (code: string) =>
      db.prepare(`INSERT INTO menu_categories (code, label) VALUES (?, ?)`).run(code, code);

    runInTransaction(db, () => addCategory('committed'));
    expect(() =>
      runInTransaction(db, () => {
        addCategory('rolled_back');
        throw new Error('boom');
      }),
    ).toThrow('boom');

    const codes = (db.prepare('SELECT code FROM menu_categories').all() as { code: string }[]).map((r) => r.code);
    expect(codes).toContain('committed');
    expect(codes).not.toContain('rolled_back');
    db.close();
  });
});

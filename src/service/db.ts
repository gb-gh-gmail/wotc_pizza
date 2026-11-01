import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import type { Logger } from '../lib/logger.js';

const DB_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../../db');

/** Bump when schema.sql changes incompatibly; see docs/decisions.md D2. */
export const SCHEMA_VERSION = 1;

export interface OpenDatabaseOptions {
  /** File path, or ':memory:' for tests. */
  path: string;
  /** Load db/seed.sql into an empty menu (idempotent: skipped if a menu exists). */
  seed?: boolean;
  logger?: Pick<Logger, 'info'>;
}

/**
 * Open the database and make it ready: connection settings, schema on first
 * run, optional seed data. Safe to call against an existing file.
 */
export function openDatabase(options: OpenDatabaseOptions): DatabaseSync {
  const { path, logger } = options;
  if (path !== ':memory:') mkdirSync(dirname(resolve(path)), { recursive: true });

  const db = new DatabaseSync(path);
  try {
    // Must be set per connection; SQLite defaults it OFF.
    db.exec('PRAGMA foreign_keys = ON');
    // Wait briefly instead of failing immediately if another writer holds the lock.
    db.exec('PRAGMA busy_timeout = 5000');
    // WAL lets readers proceed during a write; not applicable to in-memory databases.
    if (path !== ':memory:') db.exec('PRAGMA journal_mode = WAL');

    applySchema(db, logger);
    if (options.seed) applySeed(db, logger);
  } catch (err) {
    db.close();
    throw err;
  }
  return db;
}

function userVersion(db: DatabaseSync): number {
  return (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
}

function applySchema(db: DatabaseSync, logger?: Pick<Logger, 'info'>): void {
  const current = userVersion(db);
  if (current === SCHEMA_VERSION) return;
  if (current > SCHEMA_VERSION) {
    throw new Error(`database schema version ${current} is newer than this build supports (${SCHEMA_VERSION})`);
  }
  if (current !== 0) {
    // No migrations exist yet; refuse rather than guess at an upgrade.
    throw new Error(`no migration from schema version ${current} to ${SCHEMA_VERSION}`);
  }

  logger?.info(`applying schema v${SCHEMA_VERSION}`);
  runInTransaction(db, () => {
    db.exec(readFileSync(resolve(DB_DIR, 'schema.sql'), 'utf8'));
    // user_version can't be parameterised; the value is a trusted constant.
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
  });
}

function applySeed(db: DatabaseSync, logger?: Pick<Logger, 'info'>): void {
  const { n } = db.prepare('SELECT COUNT(*) AS n FROM menus').get() as { n: number };
  if (n > 0) return;
  logger?.info('seeding menu data');
  runInTransaction(db, () => db.exec(readFileSync(resolve(DB_DIR, 'seed.sql'), 'utf8')));
}

/** Run `fn` atomically: all of its writes commit together or none do. */
export function runInTransaction<T>(db: DatabaseSync, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

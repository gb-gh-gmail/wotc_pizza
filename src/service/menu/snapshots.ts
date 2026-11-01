import { createHash, randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { MenuSnapshot } from '../../core/menu.js';
import { getUserMenuExpirySeconds } from '../settings.js';
import { getActiveMenu } from './repo.js';

export interface StoredSnapshot {
  token: string;
  data: MenuSnapshot;
  createdAt: string;
  expiresAt: string;
}

/**
 * A snapshot is shared with the next customer only while at least this fraction of
 * its life remains, so everyone gets nearly the full window to finish their order
 * and the table grows by at most one row per (life / 6) per distinct menu.
 */
const REUSE_MIN_REMAINING = 5 / 6;

const plus = (from: Date, seconds: number): string => new Date(from.getTime() + seconds * 1000).toISOString();

/**
 * Hash of what the customer sees and is charged. `pricedAt` is excluded on purpose:
 * it differs on every request, but two requests that show identical prices should
 * be able to share one snapshot.
 */
function contentHash(data: MenuSnapshot): string {
  const { pricedAt: _ignored, ...content } = data;
  return createHash('sha256').update(JSON.stringify(content)).digest('hex');
}

/**
 * The snapshot to give a customer loading the menu at `now`: an existing one with
 * enough life left and identical prices, otherwise a new one. Null if there is no
 * menu in effect. Throws if the menu or the expiry setting is misconfigured.
 */
export function getOrCreateSnapshot(db: DatabaseSync, now: Date): StoredSnapshot | null {
  const data = getActiveMenu(db, now);
  if (!data) return null;

  const ttl = getUserMenuExpirySeconds(db);
  const hash = contentHash(data);
  const nowIso = now.toISOString();

  const reusable = db
    .prepare(
      `SELECT token, data, created_at, expires_at FROM menu_snapshots
        WHERE content_hash = ? AND expires_at >= ? ORDER BY created_at DESC LIMIT 1`,
    )
    .get(hash, plus(now, Math.floor(ttl * REUSE_MIN_REMAINING))) as
    | { token: string; data: string; created_at: string; expires_at: string }
    | undefined;
  if (reusable) {
    return { token: reusable.token, data: JSON.parse(reusable.data), createdAt: reusable.created_at, expiresAt: reusable.expires_at };
  }

  const token = randomUUID();
  const expiresAt = plus(now, ttl);
  db.prepare(
    `INSERT INTO menu_snapshots (token, menu_id, content_hash, data, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(token, data.menu.id, hash, JSON.stringify(data), nowIso, expiresAt);
  return { token, data, createdAt: nowIso, expiresAt };
}

/** Look a snapshot up by the token a client sent. `expired` says whether its window has closed at `now`. */
export function findSnapshot(db: DatabaseSync, token: string, now: Date): (StoredSnapshot & { expired: boolean }) | null {
  const row = db.prepare(`SELECT token, data, created_at, expires_at FROM menu_snapshots WHERE token = ?`).get(token) as
    | { token: string; data: string; created_at: string; expires_at: string }
    | undefined;
  if (!row) return null;
  return {
    token: row.token,
    data: JSON.parse(row.data),
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    expired: row.expires_at <= now.toISOString(),
  };
}

/** Delete expired snapshots that no order, and no earlier version of an order, refers to. Returns how many were removed. */
export function purgeExpiredSnapshots(db: DatabaseSync, now: Date): number {
  const result = db
    .prepare(
      `DELETE FROM menu_snapshots WHERE expires_at <= ?
          AND token NOT IN (SELECT menu_snapshot_token FROM orders)
          AND token NOT IN (SELECT menu_snapshot_token FROM order_revisions)`,
    )
    .run(now.toISOString());
  return Number(result.changes);
}

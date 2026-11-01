import type { DatabaseSync } from 'node:sqlite';

/** A setting is missing or has an unusable value. A config error: the service cannot guess a default. */
export class SettingsError extends Error {}

/** Read an integer setting, requiring it to lie within [min, max]. */
export function getIntSetting(db: DatabaseSync, key: string, min: number, max: number): number {
  const row = db.prepare(`SELECT value FROM settings WHERE key = ?`).get(key) as { value: number } | undefined;
  if (!row) throw new SettingsError(`setting "${key}" is missing`);
  if (!Number.isInteger(row.value) || row.value < min || row.value > max) {
    throw new SettingsError(`setting "${key}" must be a whole number from ${min} to ${max}, got ${row.value}`);
  }
  return row.value;
}

/** Seconds a customer has to submit an order after loading the menu. */
export const USER_MENU_EXPIRY_SECONDS = 'user_menu_expiry_seconds';
export const getUserMenuExpirySeconds = (db: DatabaseSync): number =>
  getIntSetting(db, USER_MENU_EXPIRY_SECONDS, 60, 86_400); // 1 minute to 1 day

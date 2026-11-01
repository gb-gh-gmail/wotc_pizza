import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/service/app.js';
import { loadConfig } from '../../src/service/config.js';
import { openDatabase } from '../../src/service/db.js';

const db = openDatabase({ path: ':memory:' });
const app = buildApp({ db });
afterEach(async () => {
  await app.close();
});

describe('GET /health', () => {
  it('reports ok while the database answers', async () => {
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok', db: 'ok' });
  });

  it('reports 503 once the database is unavailable', async () => {
    const closed = openDatabase({ path: ':memory:' });
    const unhealthy = buildApp({ db: closed });
    closed.close();

    const res = await unhealthy.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ status: 'unavailable', db: 'error' });
    await unhealthy.close();
  });
});

describe('loadConfig', () => {
  it('defaults to loopback:3001, a local db file, and no seeding', () => {
    expect(loadConfig({})).toMatchObject({ host: '127.0.0.1', port: 3001, dbPath: 'data/orders.db', seedDb: false });
  });

  it('reads overrides and rejects bad numbers', () => {
    expect(loadConfig({ PORT: '8080', HOST: '0.0.0.0', DB_PATH: ':memory:', SEED_DB: 'true' })).toMatchObject({
      host: '0.0.0.0',
      port: 8080,
      dbPath: ':memory:',
      seedDb: true,
    });
    expect(() => loadConfig({ PORT: 'abc' })).toThrow(/PORT/);
  });
});

// Delete the development database so the next start recreates it from db/schema.sql
// (and reseeds it, if SEED_DB=true as in .env.development). This DELETES ALL ORDERS.
//
//   npm run db:reset                  -> data/orders.db
//   DB_PATH=other/file.db npm run db:reset
import { existsSync, rmSync } from 'node:fs';

const path = process.env.DB_PATH || 'data/orders.db';
if (path === ':memory:') {
  console.log('DB_PATH is :memory:, nothing to delete');
  process.exit(0);
}

// SQLite keeps a write-ahead log and a shared-memory file alongside the database.
let removed = 0;
for (const file of [path, `${path}-wal`, `${path}-shm`]) {
  if (existsSync(file)) {
    rmSync(file);
    removed++;
  }
}
console.log(removed ? `Deleted ${path} (${removed} file(s)). It will be recreated on the next start.` : `${path} does not exist, nothing to delete.`);

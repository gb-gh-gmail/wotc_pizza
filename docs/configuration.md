# Configuration and scripts

Everything you can change about how the project runs. To just run and test it you do not need
this: see the [README](../README.md) (`npm install`, `npm run dev`, `npm test`).

## Requirements

- **Node 24** (the version in `.nvmrc`; with nvm, `nvm use`). The service uses Node's built-in
  SQLite (`node:sqlite`), so there is no database to install and nothing native to build.
- npm.

## npm scripts

| Script | What it does |
|---|---|
| `npm run dev` | Runs the order service and the order builder together, with the settings in `.env.development`, and restarts each when its code changes |
| `npm run dev:service` | The same, for the order service only |
| `npm run dev:builder` | The same, for the order builder only |
| `npm run start:service` | Runs the order service once, without the dev settings or auto-restart |
| `npm run start:builder` | Runs the order builder once, without the dev settings or auto-restart |
| `npm test` | Runs all the automated tests once |
| `npm run test:watch` | Runs the tests and re-runs them as files change |
| `npm run typecheck` | Type-checks the TypeScript without producing any output |
| `npm run db:reset` | Deletes the development database (and its `-wal` / `-shm` files); it is recreated, and reseeded if `SEED_DB=true`, on the next start. **This deletes all orders.** |
| `npm run seed:orders` | Places nine sample orders through the running order service and moves them to every state. Refuses if the service already has orders; `npm run seed:orders -- --add` adds them anyway. See below |

The two `start:*` scripts do not read `.env.development`, so they use the defaults below. In
particular `SEED_DB` is off, so a fresh database has no menu until you set `SEED_DB=true`.

## Environment variables

Both programs read their settings from environment variables. `npm run dev` loads
`.env.development` (it has no secrets and is safe to commit). A variable already set in your shell
takes precedence over the file.

To set one for a single run:

```
# PowerShell
$env:PORT = "3005"; npm run start:service

# bash
PORT=3005 npm run start:service
```

### Order service

| Variable | Meaning | Default | In `.env.development` |
|---|---|---|---|
| `HOST` | Address to listen on. Use `0.0.0.0` inside a container | `127.0.0.1` | `127.0.0.1` |
| `PORT` | Port to listen on | `3001` | `3001` |
| `DB_PATH` | SQLite database file (the folder is created if needed). `:memory:` for a throwaway database | `data/orders.db` | `data/orders.db` |
| `SEED_DB` | Load the demo menu, promo codes and tax rate into an **empty** database on start-up. Never seeds a database that already has a menu | off | `true` |
| `UI_RELOAD` | Re-read the kitchen and status pages from disk on every request, so an edit shows up on refresh. Set to `false` to serve the copy read at start-up | on | `true` |
| `SHUTDOWN_TIMEOUT_MS` | How long to wait for a clean shutdown before forcing the process to exit | `10000` | `3000` |
| `LOG_LEVEL` | `trace`, `debug`, `info`, `warn`, `error`, `fatal` or `silent`. An invalid value stops the service starting | `info` | `debug` |
| `LOG_PRETTY` | `true` for readable coloured logs; otherwise one JSON object per line (better for log tools) | off | `true` |

### Order builder

| Variable | Meaning | Default | In `.env.development` |
|---|---|---|---|
| `BUILDER_HOST` | Address to listen on | `127.0.0.1` | `127.0.0.1` |
| `BUILDER_PORT` | Port to listen on (named differently from `PORT` so the two programs can share one environment file) | `3000` | `3000` |
| `ORDER_SERVICE_URL` | Where to find the order service | `http://127.0.0.1:3001` | `http://127.0.0.1:3001` |
| `ORDER_SERVICE_TIMEOUT_MS` | How long to wait for the order service before telling the customer it is slow (a 504) | `8000` | not set |
| `UI_RELOAD` | As above, for the builder's pages and scripts | on | `true` |
| `SHUTDOWN_TIMEOUT_MS` | As above | `10000` | `3000` |
| `LOG_LEVEL`, `LOG_PRETTY` | As above | `info`, off | `debug`, `true` |

## Sample data: the menu and the sample orders

There are two separate kinds of sample data, loaded in different ways.

| What | How it gets there | Contents |
|---|---|---|
| **The menu, promo codes and tax rate** | `SEED_DB=true` loads `db/seed.sql` into an *empty* database when the service starts (on in `.env.development`) | The Standard Menu (small, medium, large; six basic and six premium toppings), the `ILOVEPIZZA` and `SAVE5` promos, and the 6.5% tax rate, exactly as in the brief |
| **Sample orders** | `npm run seed:orders` while the service is running | Nine orders placed by calling the service's real endpoints (menu, quote, place, change, and the kitchen's advance and cancel), so they are exactly what the service would produce |

The sample orders, defined in `scripts/seed-orders.mjs`. They are real orders that were entered by hand
through the app and captured from its database, so they are realistic rather than invented: heavy on
toppings, with a mix of promos and tips. The tests check that the script reproduces each one **to the
cent**.

| Order | Ends up | Shows |
|---|---|---|
| `delivered-with-promo` | Delivered | Three pizzas loaded with toppings, `ILOVEPIZZA`, a 20% tip |
| `changed-then-cancelled` | Cancelled | Five medium pizzas, changed once (it has two versions), then cancelled by the customer |
| `kitchen-cancelled-early` | Cancelled | Cancelled by the kitchen before it was started, with a reason |
| `kitchen-cancelled-when-ready` | Cancelled | Cancelled by the kitchen when it was ready for pickup, with a reason |
| `delivered-large-tip` | Delivered | A 75% tip, which has to be confirmed (the script confirms it) |
| `delivered-save5` | Delivered | `SAVE5` on a large order, a 15% tip |
| `started-with-promo` | Started | `ILOVEPIZZA` and a $15 dollar tip |
| `ready-for-pickup` | Ready for pickup | Four pizzas loaded with toppings and a 17.5% tip |
| `waiting-for-kitchen` | Not started | `SAVE5` and a 10% tip, not yet started |

To use it:
1. Start the service with an empty database: `npm run db:reset`, then `npm run dev`.
2. In another terminal: `npm run seed:orders`.
3. Open the kitchen screen (http://localhost:3001/kitchen) and tick *Show delivered & cancelled* to see
   them all; the script prints a status-page link for each.

The script reads `ORDER_SERVICE_URL` (default `http://127.0.0.1:3001`) to find the service and
`BUILDER_URL` (default `http://localhost:3000`) only to print links. If the service is not running, or
the database has no menu, it says so and what to do. Each run uses its own retry keys, so running it
again with `--add` adds a second set rather than clashing with the first.

## Settings that live in the database

Some things are data rather than environment variables, so they can change while the service runs,
with no deploy. Change them with any SQLite tool on the database file (`data/orders.db` by default).

| What | Where | Notes |
|---|---|---|
| How long a customer's prices are held | `settings` table, key `user_menu_expiry_seconds` | Default `1800` (30 minutes); must be 60 to 86400. Takes effect for the next menu load. If it is missing or out of range the menu is unavailable rather than guessing |
| Menu items, sizes, toppings and their prices | `menu_items`, `prices` | Prices are effective-dated: change a price by closing the old row (`effective_to`) and adding a new one, never by editing a price in use |
| Tax rate | `tax_rates` | Effective-dated in the same way; two rates cannot overlap |
| Promo codes | `promos` | A promo is a row; `exclusive` (default on) means it cannot be combined with another promo; `active`, `starts_at` and `ends_at` switch it on and off |

Timestamps in these tables must be UTC in exactly this form: `2026-01-01T00:00:00.000Z`. The database
refuses anything else. The reasoning is in [decisions.md](decisions.md) (D4, D5, D10, D12, D25).

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| The service stops at start-up saying the database has an older schema version | The code's schema changed since the database file was made. For a development database run `npm run db:reset` (this deletes its orders) |
| "Address already in use" | Something is already listening on port 3000 or 3001: an earlier `npm run dev` still running, or another program. Stop it, or choose other ports with `PORT` and `BUILDER_PORT` (and point `ORDER_SERVICE_URL` at the service's new port) |
| The customer page loads but says it cannot reach the restaurant | The order service is not running, or `ORDER_SERVICE_URL` points at the wrong place |
| The page shows a menu error ("temporarily unavailable" or "no menu available") | The database has no menu (start with `SEED_DB=true`) or its menu data is inconsistent (the service logs which item) |
| A page looks out of date after an edit | Pages are re-read on every request unless `UI_RELOAD=false`; check that, and that the browser tab was reloaded |

## Where the files are

| Path | What |
|---|---|
| `.env.development` | Settings used by `npm run dev` |
| `.nvmrc` | The Node version |
| `data/` | The development database (not committed) |
| `db/schema.sql`, `db/seed.sql` | The database structure, and the demo menu, promos and tax rate |
| `tsconfig.json` | TypeScript settings |

# Decisions log

Short records of non-obvious decisions and why we made them. Newest at the bottom.
Status: **Decided**, **Open** (needs a call), or **Superseded** (kept for history).

---

## D1. Runtime: Node 24 + TypeScript — Decided
Node 24 LTS (`.nvmrc`), TypeScript, Fastify for the HTTP service, vitest for tests.
**Why:** one language across the builder UI and the service lets both import the same
pricing module. Node 26 only just reached LTS; 24 is mature.

## D2. Storage: SQLite via built-in `node:sqlite` — Decided
**Why:** no hosted DB is required. `better-sqlite3` failed to compile on the dev machine
(no prebuilt binary) and would also complicate the Docker image. `node:sqlite` ships with
Node 24, so there is nothing native to build. Schema lives in `db/schema.sql`.

## D3. Money is integer cents; percentages are integer basis points — Decided
**Why:** exact arithmetic with no floating point. 8% is stored as `800` bps.
Every place that divides applies one documented rounding rule (see D9).
**Why not float/double:** binary floats can't represent most decimal fractions
(`0.1 + 0.2 = 0.30000000000000004`), so sums, tax and discounts drift and the total shown
could differ by a cent from the total charged. **Why not DECIMAL/NUMERIC:** SQLite's
`NUMERIC` affinity is a float underneath, so it gives no exactness. Integers add and
compare exactly in SQLite, JavaScript (safe up to 2^53 cents) and JSON. Dollars are only
formatted at the display edge.

## D4. Menu, prices and promos are data — Decided
Sizes and toppings are rows in `menu_items`; prices are rows in `prices`; promos are rows
in `promos`. **Why:** the brief requires adding a size/topping/category/promo without
touching core pricing logic.

## D5. Prices are a separate, effective-dated table linked to the menu item — Decided
`prices(menu_item_id, price_type static|percentage, amount, effective_from, effective_to)`.
- `static`: `amount` is cents (small pizza = 500).
- `percentage`: `amount` is basis points **of the base pizza (size) price in the same
  line** (basic topping = 800).

**Why:** price changes are an INSERT, with history kept, and don't alter existing orders
(orders snapshot the prices they were charged).
**Supersedes** the first draft, which put the rate on a topping category.
**No overlap trigger on `prices`:** deliberate. Several menus may exist (past, future, or
alternates), each with its own price rows for what is conceptually the same item, so
overlapping windows across the table are legitimate. The service resolves a price by
`menu_item_id` + the order time, and since an item belongs to one menu, ambiguity can only
come from two rows for the *same item* with overlapping windows. The service must treat that
as a configuration error rather than pick one.
**Trade-off:** changing "all premium toppings" now touches one row per topping rather than
one category row. Accepted for per-item flexibility (a single topping can be repriced or
made a static price). `menu_categories` still exists, but only for grouping and display.
If bulk repricing becomes painful, the escape hatch is allowing a price row to point at a
category instead of an item.

## D6. Promos: one `exclusive` flag instead of a conflicts table — Decided
`promos.exclusive` defaults to 1: the promo can't be combined with any other promo.
**Why:** simpler than pairwise rows and covers the stated rule (SAVE5 vs ILOVEPIZZA).
**Trade-off:** it can't express "A conflicts with B but both combine with C". We accept
that; if it comes up, add a pairwise table then.
Orders keep a list of promo codes (`order_promos`) so that an attempted combination is
validated and rejected with a clear message, rather than being impossible to express.

## D7. Promo `kind` strategies live in code; parameters live in data — Decided
`percent_off` and `flat_off` are registered strategies. A new promo of an existing kind is
an INSERT. A genuinely new rule shape is one new registered strategy, with core pricing
untouched. **Why:** attempting to encode arbitrary rules in SQL would be a worse DSL than
TypeScript.

## D8. Order status includes `CANCELLED` — Decided
The brief lists four statuses (Not Started, Started, Ready for Pickup, Delivered) but also
says a customer can cancel while Not Started. A cancelled order has to be *somewhere*, and
deleting it would lose the record (and break retries and audit), so we add a fifth,
terminal status: `CANCELLED`. Also logged as assumption A1 in `docs/assumptions.md`.

**State machine** (anything not listed is rejected with 409). Rules live in
`src/service/orders/state.ts`:
```
NOT_STARTED ──▶ STARTED ──▶ READY_FOR_PICKUP ──▶ DELIVERED      (kitchen advances)

CANCELLED  <──  customer: from NOT_STARTED only
           <──  kitchen:  from NOT_STARTED, STARTED or READY_FOR_PICKUP
```
- **Who may cancel differs.** The customer only before the kitchen starts (the brief's rule).
  The kitchen at any status that isn't final: it may have to scrap an order it already
  started (assumption A4, which supersedes the first draft that applied the customer's rule
  to both).
- Customer edits are allowed only from `NOT_STARTED`.
- `CANCELLED` and `DELIVERED` are terminal: no transitions out, no edits, nobody can cancel
  a delivered order.
- Cancelling an already-cancelled order succeeds again with the same result (idempotent),
  so a retry after a timeout is safe; the first reason is kept.
- **The status is re-checked at the moment of every change**, inside the write transaction,
  whatever the caller's screen last showed. Callers may also send `expectedStatus` (the
  status they last saw): if the real status differs the call is refused with
  `status_changed` and nothing is applied. Refusals use stable codes so clients can act on
  them: `order_cancelled` ("Order has been cancelled"), `status_changed`, `not_allowed`.
- Every change is a conditional update (`WHERE status = <the status just read>`) plus a
  `version` bump, so a cancel racing the kitchen's start has exactly one winner.
- **Every change is recorded** in `order_status_events`: from-status, to-status, **who**
  (`customer` / `kitchen` / `system`) and **when** (UTC), written in the same transaction as
  the change. The cancellation reason lives on the order. Order creation will write the
  first event (no from-status) once `POST /orders` exists. The history is not yet exposed
  by any API.

## D9. Rounding: half-up to the whole cent, at each derived amount — Decided
Each derived amount (percentage topping price, percentage discount, tax, percentage tip)
is rounded half-up to a whole cent at the moment it is computed, and the results are then
summed as integers. **Why:** every figure the customer sees is itself a whole-cent amount
that adds up exactly to the total, and the builder and service produce the same numbers.
**How:** all amounts are non-negative integers, so `round(n / d)` is computed in integer
arithmetic as `floor((2n + d) / (2d))` (e.g. 77.5¢ → 78¢, 77.4¢ → 77¢), with no floating
point involved. One shared helper does this; nothing else may divide money.
All standard menu prices already land on whole cents, so this only matters when prices or
rates change (or for tax and percentage tips); tests must pin the .5 boundaries.
**Why not plain `Math.round(n / d)` or SQL `ROUND(x / 100.0, 2)`:** those divide as floats.
At money-sized values they virtually always agree, but the integer form is exact by
construction, and tie-breaking differs between engines (`Math.round` rounds ties toward
+∞; SQLite `ROUND` rounds away from zero). `ROUND(cents / 100.0, 2)` is fine for
*display* (cents → dollars, no business rounding), never for computing amounts.
A property test checks the helper against a reference on random inputs.
**Not decided here:** the order in which discount, tax and tip are applied. That belongs
in the assumptions list.

## D10. Tax is an effective-dated `tax_rates` table; orders reference it — Decided
`tax_rates(name, rate_bps, effective_from, effective_to, …)`, seeded with 6.5% (650 bps).
`orders.tax_rate_id` is a foreign key to the rate used; `tax_cents` is stored too.
**Why:** a rate change is an INSERT with history kept, no deploy or config change, and an
order can always be traced to the rate it was taxed at. Considered an env var (simplest,
but invisible in the data and not versioned) and a `settings` table (one table for one
number, still no history).
**Rules:** a used row is never edited; changes are a new row. The rate applies to the
order total after discounts and before tip (see assumptions).
**Overlap is blocked by triggers** (`trg_tax_rates_no_overlap_insert` / `_update`), same
half-open `[from, to)` rules and UTC-`Z` timestamp requirement as `menus` (D12), so "the
rate at time T" has one answer. Unlike `prices` (D5) there is a single tax schedule, so
overlap is never legitimate. The service should still treat *zero* matching rows (a gap)
as a configuration error and refuse to price, rather than assume 0%.

## D11. Surrogate integer IDs everywhere; `code` is a unique slug, not the key — Decided
`menus`, `menu_categories`, `menu_items` and `promos` use `INTEGER PRIMARY KEY AUTOINCREMENT`
with a `UNIQUE` `code`. **Why:** foreign keys stay uniform and small, renaming a code
doesn't cascade through order history, and the same code (e.g. `small`) can exist on
different menus. `orders` keeps a text UUID because its ID is handed to customers and
shouldn't be guessable or sequential.
Customer-facing input still uses codes (`ILOVEPIZZA`, `pepperoni`); the service resolves
them to IDs.

## D12. A `menus` table sits above `menu_items` — Decided
A menu has a name, description, `active` flag, effective dates and created/updated
timestamps; every menu item belongs to one menu, and each order records its `menu_id`.
**Why:** a revised or seasonal menu is a new row rather than edits to live data, and old
orders stay attributable to the menu they were priced against. Menu-level effective dates
control which menu is orderable; price-level effective dates (D5) control which price
applies within it.
**Active menus may not overlap in time.** Enforced in the database by triggers
(`trg_menus_no_overlap_insert` / `_update`), because SQLite `CHECK` constraints can't see
other rows. Windows are half-open `[from, to)` so back-to-back menus are allowed;
`effective_to = NULL` is open-ended; inactive menus are exempt. So "which menu applies at
time T" has exactly one answer: the single active menu whose window contains T.
**Caveat:** the comparison is lexicographic, so timestamps must always be stored as UTC
ISO-8601 with a `Z` suffix. The service must normalise before writing.

## D13. Menu item type is a lookup table, not a CHECK string — Decided
`menu_item_types` (`size`, `topping`, seeded in the schema) with `menu_items.type_id`
as a foreign key. **Why:** a new kind of item (side, drink) is an INSERT rather than a
schema change to a `CHECK` list, and it matches how categories are modelled.
The rows are seeded in `schema.sql` because the application depends on `size` and
`topping` existing. The rule "a line's size must be a `size`, its toppings must be
`topping`" is still enforced in the service, since SQLite can't check a column's value in
another table without a trigger.

## D14. Order lines store the `price_id` they were priced with — Decided
`order_items.price_id` (the size price) and `order_item_toppings.price_id` (each topping's
price row), alongside the cents snapshots. **Why:** the cents snapshot says what was
charged; the `price_id` says *why* (which price rule, which effective window), so a
disputed or re-priced order can be audited, and an order update can tell whether a price
changed underneath it. Toppings get it too because they are priced from the same table.
Note a percentage price needs the size to resolve to cents, so the snapshot cents are
per-line, not per-price-row.

## D15. Tests: vitest + fast-check — Decided
vitest runs unit, DB and service tests; fast-check generates random orders for property
tests (e.g. builder total equals service total, total is never negative, `SAVE5` only
applies over $20). **Why:** vitest is zero-config for TypeScript/ESM, has `test.each` for
price tables and fake timers for the kitchen simulation; Fastify's `app.inject()` tests the
HTTP layer in-process. `node:test` was the zero-dependency alternative; jest needs extra
ESM/TS setup. Layout: `test/unit`, `test/db`, `test/service`.

## D16. One shutdown path for every way a process can stop — Decided
`src/lib/lifecycle.ts`: SIGINT, SIGTERM, SIGHUP (and SIGBREAK on Windows), uncaught
exceptions, unhandled rejections and start-up failure all call a single `shutdown()`.
Hooks run in reverse registration order (so the HTTP server closes before the database it
uses), a failing hook doesn't stop the rest, repeated requests are ignored, and a timeout
(`SHUTDOWN_TIMEOUT_MS`, default 10s) forces exit so a hung hook can't wedge a container.
Exit code is 0 for a clean signal, 1 for crashes, failed hooks or a timeout.
**Why:** cleanup written once can't drift between handlers, and it is unit-testable with a
fake `process`. The builder service will reuse the same module.
**Limit:** real signal delivery isn't testable on Windows (`child.kill()` is a hard kill),
so signals are covered by unit tests with a fake process; confirm in Docker/Linux.

## D17. Logging: pino, standard levels, one shared instance — Decided
`src/lib/logger.ts` wraps pino (already Fastify's logger). Levels: trace, debug, info,
warn, error, fatal, plus silent for tests; `LOG_LEVEL` sets it and an invalid value fails
start-up rather than silently logging at the wrong level. `LOG_PRETTY=true` gives readable
output locally (pino-pretty, dev only); default is JSON for containers. The same instance is
given to Fastify and the lifecycle so everything logs at one level. Auth headers are
redacted. **Why:** structured logs are greppable and machine-parseable, and pino is the
lowest-overhead option that Fastify supports natively. Rule of thumb: `info` for lifecycle
and order state changes, `warn` for rejected input and retries, `error` for failures we
handled, `fatal` only for crashes.

## D18. Dev mode: `tsx watch` with a committed `.env.development` — Decided
`npm run dev:service` restarts the service on any source change, with debug-level pretty
logs and a short shutdown timeout so restarts are quick. Config comes from Node's
`--env-file` rather than `VAR=value npm run …`, which doesn't work in Windows shells (and
avoids adding `cross-env`). The file holds no secrets. Production/Docker uses real
environment variables and JSON logs. A restart exercises the same shutdown path as a
deploy; on Windows the watcher hard-kills the old process, so hooks are only observable
on Linux/macOS/Docker.

## D19. Database bootstrap: schema by version, seed on request, DB owned by `main` — Decided
`src/service/db.ts` opens SQLite and prepares it in one place: `foreign_keys=ON` (off by
default in SQLite, per connection), `busy_timeout`, and WAL for file databases. The schema
is applied once, inside a transaction, and stamped with `PRAGMA user_version`. A database
from a *newer* build is refused, and an older version with no migration path is refused
rather than guessed at. **Why:** `user_version` is the lightest way to know what is in the
file with no migrations table or tool; real migrations can slot in when the schema first
changes after release.
- **Seeding is opt-in** (`SEED_DB=true`, on in `.env.development`) and skipped if any menu
  exists, so restarts never duplicate data. Production data is not seeded implicitly.
- **`main.ts` creates the database and registers its close hook; `buildApp` only receives
  it.** The app owns nothing it must clean up, tests pass an in-memory database, and the
  close order (HTTP server first, database last) follows from registration order (D16).
- `/health` is a readiness check: it runs `SELECT 1` and returns 503 if the database is
  unavailable.
- `runInTransaction` uses `BEGIN IMMEDIATE`, taking the write lock up front so a
  read-then-write (such as "cancel only if still Not Started") can't be interleaved by
  another writer.
**Config:** `DB_PATH` (default `data/orders.db`, git-ignored), `SEED_DB`.

## D20. Kitchen screen on the order service, with an optional cancellation reason — Decided
The order service serves a small page at `/kitchen` showing each order's received time,
age, items, total and status, with a button to move it to the next status and a
**Cancel…** button. This is how the restaurant side advances status (the brief asks us to
simulate it and document how). Plain HTML + one JS file, polling every 3s; no framework or
build step.

**Cancellation reason:** `orders.cancellation_reason`, free text, optional, max 200
characters, trimmed (empty becomes none). A `CHECK` constraint allows it only on
`CANCELLED` orders. **Why:** staff and customers want to know *why* an order disappeared,
and it costs one nullable column. It is stored on the order (not only the event log) so the
list can show it without a join. Cancelling an already-cancelled order keeps the original
reason, so a retry can't overwrite it.

**Design choices**
- **The server owns the rules.** The state machine lives in `orders/state.ts`; each order in
  the API carries `nextStatus` and `canCancel`, so the UI has no rules to drift out of sync.
- **Advance names the status the screen saw** (`expectedStatus`). If the order changed
  meanwhile (a double-click, a second screen, the customer cancelling) the call is a 409
  rather than silently skipping a step. The update itself is `WHERE status = expected` inside
  a `BEGIN IMMEDIATE` transaction, so a cancel racing a start has exactly one winner.
- **The kitchen can cancel at any status that isn't final** (assumption A4); the Cancel
  button is hidden only for delivered/cancelled orders.
- **The kitchen list polls every 3s and never pauses.** Text typed into a cancel form is
  kept in memory and restored after each refresh (with focus), so a refresh can't wipe it. If
  an order stops being cancellable while its form is open (the customer cancelled first, or
  it was delivered), the form closes and the card shows the new status.
- **A stale click is answered, not obeyed.** If the screen still shows an order the customer
  has just cancelled and the kitchen clicks "Start cooking", the API replies
  `order_cancelled` / "Order has been cancelled", the screen shows that message, and the
  next refresh shows the real status. The same holds for a double-click (`status_changed`).
- **The list hides delivered/cancelled orders by default** (a toggle shows them).

## D21. Customer status page and customer cancel — Decided
The order service also serves the customer's status page at `/track/:id` (and `GET
/orders/:id` as JSON). It shows a progress bar, the items, the cancellation reason if any,
and a **Cancel order…** button only while the server says the customer may cancel
(`canCancel`, computed from the state machine; the page has no rules of its own).
- **Double-checked cancel:** the page sends the status it last saw (`expectedStatus`). The API
  ignores the page's belief about whether cancel is allowed and re-reads the real status when
  the request arrives. If the kitchen started the order in between, the customer gets a 409
  "Order status has changed since you last checked" and the order is untouched.
- **Polling stops for orders in a final status** (Delivered or Cancelled), since nothing can
  change, and for an order that doesn't exist. Otherwise it polls every 3s.
- The customer view omits kitchen-only fields (`nextStatus`).
- The customer-facing UI that builds orders is the separate order builder; this page is the
  status-check part and works with just an order ID.
- **No authentication or hardening** on `/kitchen`, per the brief ("No auth required").

## D22. Security hardening is deferred until after the build — Decided
While building features we deliberately do not spend time on security hardening. The brief
says no authentication or accounts are required, and the priority is correct pricing and a
defensible order lifecycle. So for now there is no auth on `/kitchen` or the order API, no
Content-Security-Policy or other response headers, and no rate limiting or abuse controls.
**Why:** each of these is cheap to add on a working system and wasteful to design around a
moving one; the exercise explicitly puts them out of scope.
**What still holds** because it is correctness rather than hardening: server-side input
validation (schemas, length limits), parameterised SQL, and rejecting invalid state
transitions.
**After the build** (tracked for the README's "cut / next" list): authentication for the
kitchen routes (or a separate internal port), response security headers including a CSP,
rate limiting on order submission, and a review of logged fields.

## D23. Retries are made safe with client-supplied idempotency keys — Decided
`POST /orders` takes an `Idempotency-Key`. The same key and body return the original
order; the same key with a different body gets 422. **Why:** mobile clients time out and
retry, and a duplicate order is a real cost to the restaurant.

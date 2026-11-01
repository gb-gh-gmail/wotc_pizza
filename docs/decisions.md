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
- **Every schema change bumps `SCHEMA_VERSION`, and a test enforces it.** Because there are no
  migrations yet, the schema is edited in place during development. Once, a change (the
  `menu_snapshots` table) was made without a bump; an existing dev database was stamped with
  the old version, so the service skipped the new tables and failed at start with a cryptic
  "no such table". `db.test.ts` now pins the SHA-256 of `schema.sql` to the version it belongs
  to and fails if they drift apart, with instructions. An out-of-date database is refused with
  a message that says what to do, and `npm run db:reset` deletes the dev database (it also
  removes the SQLite `-wal` / `-shm` files) so the next start recreates and reseeds it.
  Real migrations are the answer once data has to survive a schema change (see next-steps).
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
- **A "Place a new order" link is always on the page** (it sits outside the order card), in every
  state: in progress, delivered, cancelled, and when the order is not found, so a customer is never
  left at a dead end. It goes to `/`, which the builder serves.
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

## D23. Submitted prices are validated against the menu the customer was shown — Decided
When an order is submitted, the service verifies its prices against **the menu that was
presented to that customer**, not against whatever the back-end prices are at the moment of
submission. A price change made in the meantime does not apply to an order built from the
earlier menu.

**Why:** the customer must never be charged something different from what they were told.
The brief requires that the total shown while building matches the total the restaurant
charges. Back-end prices can change at any moment (the schema is built for scheduled
changes), and a customer can spend several minutes building an order, so checking against
"current" prices would let a price change turn an honest order into a surprise charge or a
rejection the customer cannot explain. Validating against the presented menu keeps the
promise made on screen.

**Mechanism** (details confirmed; the expiry setting and the timer are in D25):
- `GET /menu` records a **menu snapshot** on the order service, stored in the database and
  not in the builder or the browser, because only the service can say what it showed. The
  snapshot holds the resolved prices, the menu id, the tax rate in effect, and an expiry. The
  client receives only an opaque GUID (`menuToken`) and sends it back with the order.
- `POST /orders` prices the order from that snapshot, then compares its total with the total
  the customer saw. It never trusts prices sent by the client; the client's numbers are only
  a claim to check.
- **Disagreement is communicated, not hidden:** items that are not on the presented menu get
  a 422 naming them; a total that differs gets a 409 `price_mismatch` with the
  authoritative line-by-line quote; an expired or unknown token gets a 409 `menu_expired`
  with a fresh quote and token. In every case no order is created, and the customer confirms
  the corrected prices before the order is accepted. The service never silently charges a
  different amount than the customer saw.
- Snapshot reuse: an identical, unexpired snapshot is reused so the table doesn't grow with
  every page load.
- The submit is idempotent (D24), so a timeout-and-retry cannot create two orders.
- **Confirmed defaults:** the snapshot stores the resolved prices as JSON (immune to later
  edits of a price row); the tax rate is locked in the snapshot; promo codes are checked live
  at submit; an expired token returns a fresh quote for the customer to confirm.

## D24. The pricing engine is one pure function; promos are their own module — Decided
`src/core/pricing.ts`: `priceOrder(order, menuSnapshot, promos)` takes one order object and
returns the complete breakdown: priced lines, subtotal, per-promo outcomes, discount, tax,
tip and total (or every problem with the order at once). It reads no database, clock or
network, and writes nothing. **Why:** one place defines what an order costs, so the service
that charges and the page that displays the running total can use the very same code, and
it can be tested exhaustively with no setup. Writing the order is the API's job, done only
after the engine's total has been checked against the one the customer saw (D23).

**Three stages, each its own module and tested on its own.** `priceOrder` only conducts them:
1. `lines.ts` `priceLines`: validate the lines and price them → subtotal.
2. `promos.ts` `applyPromos`: apply promo codes to that priced order → discount.
3. `totals.ts` `computeTotals`: tax on the discounted amount, then tip, then total; plus
   `checkTip` (tip validation) and `inconsistencies`, the final check that the breakdown adds
   up (lines sum to the subtotal, total = taxable + tax + tip, nothing negative or fractional).
   The engine runs that check on every result and throws rather than return a price that does
   not add up; it can only fire through a bug in a stage, never through customer input.

Shared input types, limits and issue types live in `order.ts` so no stage imports another.
**Why split:** each stage has rules likely to change (promo stacking, tax, tip) and each can
be tested directly and exhaustively instead of only through whole orders. Money rounding stays
in one helper (D9).

**Promo strategies receive a copy of the priced order** (`PromoOrder`: the subtotal and every
priced line with its size, toppings, unit and line prices), a fresh `structuredClone` per
strategy call. **Why:** it lets a line-specific promo ("$2 off every large pizza") be a
registered strategy with no engine change, while a strategy can neither alter the real order
nor affect the next promo. The generic rules (minimum subtotal, exclusivity, cap at the
subtotal) apply to every kind, including line-specific ones.

- **A promo that doesn't apply is not an error.** It comes back with a customer-facing
  message ("SAVE5 needs an order over $20.00 before tax"; "SAVE5 cannot be combined with
  ILOVEPIZZA") and the order still prices, so the running total can say why.
- **Invalid orders are all reported at once** (bad quantity, unknown size or topping, a
  topping twice on one pizza, an unusable tip), each with its location, instead of one at a
  time.
- **The engine tolerates any input shape** and reports problems rather than throwing,
  because its input comes from an API.
- **Extensibility:** a new size, topping or category is menu data; a new promo of an existing
  kind is a database row; a new promo kind is one entry in the kinds table.

## D25. Menu snapshots, with the expiry in a database setting — Decided
`GET /menu` returns the prices plus `menuToken`, `expiresAt` and `serverTime`. The prices are
stored as JSON in `menu_snapshots`; each order records the snapshot it was priced against.
- **Expiry is a database setting**, `user_menu_expiry_seconds` (default 1800 = 30 minutes), in
  a new `settings` table seeded by `schema.sql` (the service cannot work without it). It can
  be changed at run time with no deploy. A missing or out-of-range value (under 60 seconds or
  over a day) makes the menu unavailable rather than silently using a guess.
- **The customer is shown the deadline.** The page displays the time left, counting down
  against `serverTime` so a wrong device clock can't skew it, and opens a "session timed out"
  dialog when it passes.
- **Snapshots are shared** between customers loading identical prices while at least 5/6 of
  the window remains, so everyone gets nearly the full time and the table grows by at most one
  row per few minutes. Content is hashed without `pricedAt` so identical menus match.
- **A snapshot an order refers to is never deleted.** Expired, unreferenced ones are purged
  at start-up.
- **Why a settings table again:** an early draft had one and it was removed while tax had no
  home; tax became its own effective-dated table (D10), and this value is genuinely a
  tunable setting.

## D26. One quote path; promos re-validated on every request; any difference holds the order — Decided
`POST /quote` (service: `quoteOrder`) prices an order exactly as it would be charged and
compares it with the figures the page is showing. Placing the order (later) uses the same
`quoteOrder`, so a running total and a charge cannot come from different code.

- **A single path, with the promo work done only when promo codes are present.** There is no
  separate "apply promo" call. Adding a promo code is a quote request with that code included.
  Validating a code is stage 2 of the engine (D24), so one request answers both "is this code
  valid?" and "what is the new price?". When a promo actually applies, the breakdown also
  carries `withoutPromo` (tax, tip and total with no discount) using the same totals stage with
  a discount of zero; with no promo applied it is `null` and nothing extra is computed.
- **No circular dependency, enforced.** Layers only call downward: routes → `quoteOrder` →
  `priceOrder` → the three stages. `applyPromos` knows nothing about quotes. A test
  (`architecture.test.ts`) fails on any import cycle in `src/`, on any core module importing
  something its layer shouldn't, and on a routes module being imported by anything but `app.ts`.
  It was verified by introducing a deliberate cycle and watching it fail.
- **Promos are re-validated from scratch on every quote and every order.** The service keeps
  no "applied promo" state: the client re-sends its codes and each is checked against the promos
  as they are *now* (active flag, start/end window, exclusivity) and the order as it is *now*
  (a minimum subtotal). A promo that is switched off, expires, or stops qualifying because the
  customer changed their order is refused with a reason, even if it applied a moment ago.
  Promo rules are read live; menu prices stay locked to the snapshot (D23).
- **Any difference between what the page showed and what the service computes holds the order
  until the customer re-confirms.** A different price, a different total and a promo that no
  longer applies are all the same situation. The response carries the corrected figures and what
  changed; the page removes a refused code from the promo box and shows an information message
  that includes the reason and the updated price. Nothing is created until they confirm.
  `compareClaimed` (`core/claims.ts`) lists the differences in plain language ("Total: you were
  shown $15.98, but it is $21.30"). At quote time a mismatch is informational (`matches: false`);
  at order time it is a 409 and no order is written.
- **The snapshot is built and checked before anything is stored or sent.** The service
  resolves every price and the tax rate from live data first; inconsistent data (an item with
  no price or two prices, no tax rate, a bad expiry setting) is a 503 with no snapshot written
  and no prices or token sent. The customer's copy of the prices is for display only; an order
  is priced from the service's stored snapshot, looked up by token.
- **Unknown fields in a request are discarded, never used.** (Fastify's default.) A client
  cannot send its own discount or total; only the order itself, the token and the claimed
  figures are read, and the claimed figures are only compared, never trusted.

## D27. The order page: live totals, a checked-and-confirmed state machine, modal for submitting — Decided
The page keeps the order in memory and previews the subtotal as the customer edits. The
authoritative figures come from `POST /quote`, and **they update by themselves as the customer
edits** (the brief's running total, including tip and promo changes). **Place order** is disabled
until the order has been checked.

**Live totals.** Each edit (a pizza, topping, quantity, size, tip) restarts a 450 ms wait, so a burst
of changes (several toppings clicked, a tip typed digit by digit) sends **one** request for the final
state. If a request is already on its way when the next change arrives it is cancelled, and an answer
that still arrives is ignored if anything has changed since: **the last change always wins**
(`debounce` and `latestOnly` in `logic.js`, unit-tested with fake timers). These updates are *quiet*: a
small "Updating your total…" note, the page stays fully usable, and nothing steals keyboard focus. The
blocking overlay is only for placing or saving an order and renewing the session. A promo code is
applied with **Apply** (or Enter), not as it is typed, so a code does not cost a request per letter; a
code that is typed but not applied disables Place order, with a message, so nobody places an order
believing a promo was used. A tip that cannot be read sends nothing and shows its message. A new page
shows the total of its starting pizza at once. Verified in a real browser: a burst of five toppings sent
one request, a change during a slow update cancelled the first and the screen showed the last state, and
the change page's comparison updated with no button pressed. **Refresh total** remains for retrying
after a failed update.
- **One state machine decides it** (`logic.js`, unit-tested without a browser): *not checked* →
  *checking* → *ready* or *needs your OK* → *confirmed*; plus *timed out* and *error*. Place
  order is enabled only in *ready* and *confirmed*. **Any edit** (a pizza, a topping, quantity,
  tip, promo) returns it to *not checked* and dims the old figures, so stale figures never sit
  beside an enabled button.
- **What needs the customer's OK** (the order is held, with the reason and the new total, until
  they accept): a price that differs from what they were shown, a promo that *was* applied and
  no longer applies (it is cleared from the box), and a very large tip (A15). A promo code the
  customer just typed that is refused (a typo, or an order under $20) is only a message beside
  the box: it changes nothing they had been shown.
- **What the page claims** in each quote: the pizza prices and the pre-promo subtotal; and the
  discount, tax, tip and total too when those figures are on screen and unchanged, which is how
  a silently changed promo is caught.
- **Busy means modal.** While any request runs (check, apply, getting new prices; submit later)
  the whole page is inert and a spinner dialog shows. The spinner only appears after about 150
  ms so quick answers don't flash; Escape cannot dismiss it; a 15-second timeout turns a hung
  request into an error message instead of an endless spinner; focus returns to where it was.
- **The session is visible.** The page shows the deadline and a countdown measured on the
  *server's* clock (so a wrong device clock can't skew it), warns in the last five minutes,
  and opens a "session timed out" dialog at expiry (or if the service answers `menu_expired`).
  "Get new prices" reloads the menu, keeps the pizzas the customer built, tells them what was
  dropped if anything is no longer sold, and requires a fresh check.
- **Tip entry** is parsed from text to whole cents or basis points without floating point
  ("5", "5.50", "18.5"); negative, three decimals or letters are refused with a message.
- **Place order** sends the customer's accepted figures (the whole quote they saw) with a
  retry-safe key, behind the same modal spinner; the held-order dialog, OK / Cancel and the
  move to the status page are described in D28.

## D28. Placing an order: re-validate everything, hold on any mismatch, write all or nothing — Decided
`POST /orders` (service: `placeOrder`, built on `quoteOrder`, D26) is the only way an order
comes to exist. The request carries the menu session, the order, the figures the page is
showing (`claimed`, which must include the subtotal and total) and an `Idempotency-Key`. In
order, inside one database transaction:
1. **Is this a retry?** Looked up first (see D29).
2. **Re-price** from the stored menu snapshot against the *live* promo table; **reject bad
   data**: 422 with every problem and where it is (`invalid_order`), 409 for an expired or
   unknown session (`menu_expired` / `menu_unknown`), 400 for a malformed request (including a
   wrongly-typed field, because type coercion is off, and a missing key or claimed total).
3. **Hold on any mismatch.** If the figures the page showed differ from ours, if a promo code in
   the order no longer applies, or if the tip is very large (A15) and the customer has not
   confirmed *that amount* (`confirmations.largeTipCents` must equal the tip we computed), the
   answer is 409 `confirmation_required`: the reasons (`prices_changed`, `promo_removed`,
   `large_tip`), the corrected quote and the differences. **Nothing is written.**
4. **Otherwise write everything or nothing:** the order with the totals, tax rate and menu
   snapshot it was priced from; each line with the price ids and cents charged; each topping;
   each applied promo with its discount; the first status event (no from-status → Not Started,
   actor customer); and the idempotency record. A failure part-way rolls all of it back and does
   not consume the key (tested with a trigger that fails the last write).

**The customer's side:** a held order opens a dialog listing what changed and the new total.
**OK** accepts the updated figures and places the order with them; **Cancel** returns to the
order screen showing the corrected figures (and needing a fresh OK), having placed nothing. If
the prices keep changing (three holds in a row) the page stops and asks the customer to check
again. On success the browser is sent to `/track/:id`.

**One origin for the browser.** The status page is served by the order service, but the
browser must only ever talk to the builder, so the builder also relays `/track/*`, `/track.js`
and `/orders/*` (check status, cancel) and nothing else. In particular the kitchen screen is
not reachable through the builder (tested).

## D29. Retries are made safe with client-supplied idempotency keys — Decided
The page generates a key per attempt (`ord-` + 32 hex characters, from the browser's secure
randomness where available) and sends it as the `Idempotency-Key` header, which the builder
forwards. **Why:** mobile connections time out, and after a timeout the customer cannot know
whether the order was placed; a duplicate order is a real cost to the restaurant.
- **Same key and same order → the original order** (200, `replayed: true`), with nothing more
  written. "Same order" means the same menu session and the same lines, tip and promo codes. The
  claimed figures and confirmations are deliberately *not* part of it, so a retry that carries
  updated figures is still recognised.
- **Checked before anything else**, so a retry still gets its order even if the menu session
  expired between the attempts (tested: a retry 45 minutes later).
- **Same key, different order → 422** `idempotency_key_reused`: never answered with the wrong
  order. A new key is a new submission, so deliberately placing the same order twice is two orders.
- **The key lives as long as the attempt.** The page keeps it across a network failure, so
  pressing Place order again cannot place it twice; any edit, an expired session or a hard
  refusal starts a new attempt with a new key. The key is a row in `idempotency_keys`, with the
  request hash to detect misuse, and it is written in the same transaction as the order.
- **Changing an order uses the same mechanism** (D30): the key is bound to the order id as well
  as the content, so a key from placing, or from another order, cannot be replayed against it.

## D30. Changing an order: only while Not Started, guarded by status and version, every version kept — Decided
The brief lets the customer update an order until the kitchen starts it. `PUT /orders/:id`
(service: `updateOrder`) replaces the order's pizzas, tip and promos.

**The guard (this is the invariant).** Inside one transaction the service re-reads the order and
refuses unless it is `NOT_STARTED` (`order_locked` with the real status, or `order_cancelled`) and
is still at the `expectedVersion` the customer was looking at (`order_changed`, with the latest
order so the page can reload). The write itself is conditional on both
(`WHERE status = 'NOT_STARTED' AND version = ?`) and must change exactly one row, so a change
racing the kitchen's "start" has exactly one winner: if the change wins the kitchen then cooks the
*changed* order; if the kitchen wins the change is refused and the order is untouched. Both
directions are tested. An order that is delivered or cancelled cannot be changed for the same reason.

**Same rules as placing.** Placing and changing share `assess` (`orders/write.ts`): re-price from
the menu session the customer was shown, re-check every promo against the live table, check the
tip, and hold the change (409 `confirmation_required`, nothing written) on any difference, a
refused promo, or an unconfirmed large tip. Idempotent by key like placing (D29). Writing is
all-or-nothing: the new lines, toppings, promos, totals and revision, or nothing (tested with a
failure injected at the last write).

**Every version is kept** in `order_revisions` (revision 1 is the order as first placed). The
order rows always hold the current version; the revisions keep what was ordered, at what prices,
for how much. **Why:** "what did they originally order, and for how much?" must stay answerable,
it is the audit trail for changes, and the page can show "first placed at $X". The menu sessions
revisions refer to are never purged. A change that changes nothing (the same content at the same
prices) is not a change: nothing is written and no revision is added. A change is *not* a status
event, so the status history is untouched.

**Prices on a change.** The whole updated order is priced on a **fresh menu**, so the customer sees
and agrees to today's prices; an unchanged pizza can therefore differ if prices moved since it was
first ordered. This is deliberate and always shown, never silent (assumption A19). The alternative,
keeping each unchanged pizza at its original price, would need per-line price locking that the
brief doesn't call for.

**On the page.** The status page offers *Change my order* only while the server says `canEdit`, and
when that stops being true it removes the link and says why. The link opens a **separate page for
changing the order, at its own address `/change/<id>`** (it shares the builder's markup and code,
so it reuses everything placing uses: pizza editor, tip, promos, quote, confirm dialog, retry-safe
key, session timer). It opens with **"Your order right now"**, read-only: the status in words, each
pizza with its toppings and price, the full price breakdown, and how many times it has been
changed and what it first cost. The editor sits below, pre-filled from the saved order, and adds:
- **A comparison** of the order as it stands against the updated one, part by part (subtotal, promo
  discount, tax, tip, total), with the change to what they pay for each (a bigger discount counts
  as a lower price) and a plain sentence: "$23.21 more than your current order". It is shown as soon
  as the page opens, because the order is priced on today's menu immediately.
- **A watch.** The page looks at the order every 3 seconds. If it is no longer `NOT_STARTED`
  (started, ready, delivered or cancelled) a modal alert opens at once, even half-way through an
  edit, saying the order can no longer be changed, nothing is saved, and the way back to the status
  page; everything else is blocked. If the order was changed in another window, the alert says so
  and offers to reload. A save attempted after the order moved on gets the same alert from the
  service's answer. The watch skips a poll while a request is in flight; that request hears the
  answer itself.
- The decision "can this edit carry on?" is a pure, tested function (`watchVerdict`).

## D31. Pages are re-read on every request in development, and never cached by the browser — Decided
**What went wrong.** The servers read their page files (HTML and scripts) once at start-up, and the
dev watcher (`tsx watch`) restarts only when an *imported code module* changes, not when a page
file does. So after a page edit the running server kept serving the old copy: a customer clicking
*Change my order* got the old builder page, which loads the menu and ignores everything else, and
never asked for the order. This was reproduced (edit a page file; five seconds later the running
server still served the old one) and fixed.
**The fix.** `pageFile` (`src/lib/files.ts`) re-reads each page and script from disk on every
request. This is the **default** (`UI_RELOAD=false` turns it off); it was first an opt-in setting,
and that was not enough: a process that had been started before the setting existed kept serving
its old copy until it was fully restarted, which is exactly what happened next. A missing file
still fails at start-up. All pages and scripts are also sent with
`Cache-Control: no-cache, no-store, must-revalidate`, so a browser cannot hold on to an old copy.
**Method.** Page behaviour is checked by driving a **real browser** (the installed Chrome, headless,
through `puppeteer-core` installed in a scratch folder outside the project) against the real running
servers, recording what the page displays, every request it makes, and any console or script error.
An earlier attempt used a simulated browser (jsdom); it was useful but it ran the two scripts glued
together, so it could not catch a page that fails to *load as ES modules* (a mismatched import),
which is the main thing a real browser catches. Turning the real-browser checks into permanent tests
is the first item under "Order builder UI" in `next-steps.md`.
**How to tell what is running.** The servers' own start times (`Get-CimInstance Win32_Process`) and
the page text itself ("Change your order" at `/change/<id>`) show whether a process predates an edit.

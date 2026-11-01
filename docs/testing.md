# Testing

What is tested, why those things, and what is not covered. For the short version, see the
[README](../README.md#running-the-tests).

## Running the tests

```
npm test                       # everything, once (673 test cases, a few seconds)
npm run test:watch             # re-run as files change
npm run typecheck              # the TypeScript compiler, no output files

npx vitest run test/unit/pricing.test.ts          # one file
npx vitest run -t "retry"                         # tests whose name contains "retry"
```

Needs Node 24 and `npm install`. Nothing else: no database to start (tests use in-memory SQLite), no network,
and no running service. The tests that talk to the order service call the real Fastify app in-process
(`app.inject()`), and one suite starts a real order service on a random local port to test the builder's relay.
Time is injected, so expiry and "a price change takes effect on schedule" are tested at exact boundaries
without waiting.

Tools: **vitest** for tests, **fast-check** for property-based tests. See decision D15.

## What is here

| Folder | What it tests | Test definitions |
|---|---|---|
| `test/unit/` | The pricing engine (money, lines, promos, totals, the whole order), the order state machine, shutdown and logging, and the architecture rules | 169 |
| `test/db/` | The schema itself: constraints, overlap triggers, canonical timestamps, versioning, rollback | 26 |
| `test/service/` | The order service over HTTP: menu, snapshots, quote, place, change, customer status and cancel, kitchen, the seed script | 180 |
| `test/builder/` | The page logic (a plain module, unit-tested) and the builder's relay to a real order service | 82 |

Table-driven tests expand into several cases each, which is why 457 definitions run as 673 test cases.

## The invariants, and why these

The brief says the tests should protect what would hurt most if it broke. In a pizza-ordering system that is
money, and the guarantees around it. These are the invariants chosen, in priority order, with where each is tested.

### 1. Money is exact

Every amount is a whole number of cents, and every percentage is rounded half-up exactly once, in one helper.

- `roundDiv` matches a simple reference implementation on random inputs, is always within half a unit of the true
  answer, and refuses non-integers, negatives and a zero denominator rather than guessing. (`money.test.ts`,
  property-based)
- Rounding at the exact boundaries: $5.00 of tax at 6.5% is 32.5 cents and rounds up to 33; 1666 at 6.5% is
  108.29 and rounds down to 108. (`pricing.test.ts`, `money.test.ts`)

*Why:* an error here is a wrong charge on every order, and a floating-point or double-rounding mistake is
invisible in ordinary examples.

### 2. The total always adds up, and is built in the right order

- Subtotal, then discount, then tax on the *discounted* amount, then the tip (a percentage tip is of the bill
  after discount and tax). (`pricing.test.ts`, `totals.test.ts`)
- The brief's numbers: sizes $5, $7, $12; basic toppings 8% and premium 11% of the pizza's price; 6.5% tax.
  Every topping is priced for every size. (`pricing.test.ts`, `menu.test.ts`)
- A final check runs on every result and reports every inconsistency; a property test shows that for any valid
  inputs the result passes it. A bigger discount never raises the total, and a bigger tip never lowers it.
  (`totals.test.ts`, property-based)
- A tip is never negative, whatever the form it is entered in.

*Why:* this is the property a customer actually relies on: the pieces they see sum to what they pay.

### 3. Promos follow their rules, at the edges

- "Over $20" is strict: exactly $20.00 does not qualify, $20.01 does, and it is judged before any discount.
- `SAVE5` and `ILOVEPIZZA` cannot be combined, tested **in both orders of entry**: the first is kept and the
  second is refused with a message naming the first.
- A code that did not apply does not block a later one; an unknown code is refused and the order still prices.
- A discount is never negative and never exceeds the subtotal; with only exclusive promos, at most one ever
  applies. (properties)
- A promo that applied and no longer does (switched off, expired, or the order shrank below the minimum) is
  caught again on the next quote, because promos are re-checked on every request.

*Why:* these are the rules the brief states outright, and boundary errors ($20.00 versus $20.01) are the classic
bug.

### 4. A figure from the browser is never trusted

- A stray total sent by a client cannot set the stored total. The stored order always equals what the service
  itself quoted, checked across a range of orders. (`place.test.ts`)
- If the page's figures differ from the service's for any reason (a price, a promo, a stale page), the order is
  **held**: `409 confirmation_required`, the corrected quote, and **nothing written**. Accepting (the same order
  and key, with the corrected figures) places it; declining leaves nothing behind.
- A promo that was never valid, or stopped applying, also holds the order, so a customer is never told one thing
  and charged another.
- A very large tip (50% or more of the bill, on a bill of $40 or more) is held until confirmed *for that exact
  amount*: a confirmation of a different amount does not count, a small order is exempt, and the edge cases
  (exactly 50%, exactly $40) are tested. (`totals.test.ts`, `place.test.ts`)

*Why:* this is the central guarantee of the design (see the README's pricing write-up).

### 5. The price shown is the price paid

- A price change after a customer loaded the menu does not change what that customer pays; a customer on the
  *new* menu who still shows the old price is held with the new price. (`place.test.ts`, `snapshot.test.ts`)
- A snapshot is expired exactly at its deadline and not a moment before (one millisecond before is still valid);
  customers loading the same prices shortly apart share a snapshot, and everyone gets at least 5/6 of the window.
- Clean-up never deletes a snapshot that an order, or any earlier version of an order, refers to.
- The expiry is a database setting: changing it changes the next deadline with no deploy.

*Why:* it is the promise made to the customer, and time-based logic is where off-by-one errors live.

### 6. A retry never places or changes an order twice

- The same key and order returns the original order (`200`, `replayed: true`) and writes nothing more.
- That still works after the 30-minute session has expired (a lost response, a late retry).
- The same key with a *different* order is refused rather than answered with the wrong order; a new key is a new
  order, so two deliberate orders are two orders.
- Retries of a *change* work the same way, even after the order has since been started.
- A missing or malformed key is refused.

*Why:* the brief names this explicitly, and a duplicate order is a double charge.

### 7. The order lifecycle cannot be corrupted

- The statuses only move forward, in order; a delivered order cannot be advanced or cancelled.
- A customer's stale page cannot cancel or change an order the kitchen has started: the service checks the real
  status when the request arrives and answers with it. Tested **both ways round** (cancel first, then the kitchen
  is told; kitchen first, then the cancel is refused), and with a client that sends no expected status at all.
- A double-click on "Start cooking" advances once; the stale second request is refused.
- The kitchen can cancel at any status before delivered; cancelling twice is not an error and keeps the first
  reason; a reason over 200 characters is refused; the database refuses a reason on an order that is not cancelled.
- Every status change records who made it and when.

*Why:* this is the cancel-versus-start race the brief asks about.

### 8. Changing an order is safe

- It is allowed only while Not Started, and only against the version the customer saw; two windows saving at once
  leave one winner and nothing overwritten.
- Every version is kept; a change that alters nothing records nothing; a change is not a status change.
- It is all-or-nothing: a failure part-way leaves the order exactly as it was, and the retry then works.
- A change is held and checked by the same rules as placing.

### 9. Writes are all-or-nothing

A failure part-way through placing, changing or cancelling an order leaves the data untouched (placing also
leaves no key behind, so the retry then works), and `runInTransaction` is tested to roll back everything on
failure. Advancing an order has no failure-injection test of its own. An invalid order, an expired session or an
unknown token writes nothing.

### 10. The database enforces what the code assumes

Foreign keys are on; two active menus (or two tax rates) cannot overlap, and back-to-back windows are allowed;
every time window must be in one canonical form (this came from a real bug, see the AI usage note); a database
from an older schema is refused with a message that says what to do; and a schema change without a version bump
fails a test that pins the schema to its version.

### 11. The design stays the design

An architecture test fails if there is an import cycle, if the pricing core imports anything but itself, if a
routes module is imported from anywhere but `app.ts`, if pricing logic learns that HTTP exists, or if a quote
could rebuild prices from the live menu instead of the stored snapshot. Only the first kind of rule has been
proven to fail: once, a cycle was added on purpose (the promo module importing the engine) and the cycle and
core-layering tests failed, then it was reverted. The other rules have not been broken on purpose.

### 12. It can be extended without touching the engine

A new size and a new topping category, a flat-priced topping, a new promo that is only data, and a brand-new promo
*kind* (one registered strategy, including one that sees the priced lines) all work with the engine unchanged. A
promo kind that returns a nonsense discount (NaN, negative, fractional) is stopped and never becomes a charge; a
kind nobody registered is refused rather than guessed at. These are tested in memory against the engine
(`pricing.test.ts`, `promos.test.ts`).

### 13. The pages and the relay

The page's logic lives in a plain module (`logic.js`) so it can be unit-tested: the state machine that decides
whether Place order is allowed, how a held order is shown, last-change-wins for live totals, and the debounce.
The builder's relay is tested against a real order service: an order placed through it can be read and cancelled
through it, the idempotency key is forwarded so a retry still places once, the kitchen is *not* reachable
through it, and an unreachable or slow service gives 502 or 504.

### Sample orders

The seed script is tested too: it reproduces, to the cent, the nine orders that were entered by hand through the
app, and refuses to pile onto existing orders.

## What is not covered

Stated plainly, because a passing suite can give more confidence than it has earned.

- **True concurrency.** The cancel-versus-start and two-windows tests send one request and then the other. No
  test fires two requests at the same instant. The guarantee rests on SQLite serializing writers and on the
  conditional updates (`WHERE status = ?`), which are tested one after the other but not under contention.
- **The browser wiring.** `app.js`, the largest source file, has no automated tests. Its logic is in `logic.js`
  (tested), but the wiring (events, dialogs, focus, the overlay) was checked by hand in a real browser, and only
  once with an automated script that is not in the repository. One bug there (the page showing stale scripts)
  was found only by looking at the real thing.
- **End to end.** There is no test from a real browser through the builder to the service and back. The relay is
  tested over HTTP, and the pieces on either side are tested separately.
- **The written order description.** The brief's requirement 3 is not implemented, so it is not tested.
- **Every size and topping combination, end to end.** The menu is checked (every topping has a price on every
  size, and each equals the brief's percentage), and pricing is tested for each size and for chosen toppings, but
  there is no single test that prices every size with every topping through the whole order engine and compares
  with a hand-calculated figure.
- **Existing behaviour that review says to change.** `update.test.ts` asserts that a change is priced on today's
  menu (assumption A19). That is the behaviour under review, and the test will change with it.
- **Failure of the database itself.** A failure inside a transaction is tested; the database being missing,
  locked or corrupted is not, and the error returned is known to be inconsistent in shape.
- **Idempotency keys are never cleaned up**, so there is no test of expiry or of the table growing.
- **Load, timing and security.** Nothing here measures speed or behaviour under many users, and security
  hardening is deferred.
- **Mutation testing.** Apart from the one deliberate cycle described under invariant 11, nobody has broken the
  code on purpose to confirm a test fails, so some tests may pass for the wrong reason. This is part of the
  planned [code review](next-steps.md).
- **Docker, and a fresh-machine install.** Neither exists yet.

The full list of follow-ups is in [next-steps.md](next-steps.md).

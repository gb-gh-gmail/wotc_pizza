# Pizza order system

A small pizza-ordering system built as a take-home exercise. A customer builds an order in the
browser, sees the total update, and sends it to the restaurant. After that they can check on it,
change it, or cancel it until the kitchen starts it. The restaurant has its own screen for moving
orders along.

It is two separate programs that talk to each other over HTTP:

| Program | What it is | Default address |
|---|---|---|
| **Order builder** | The customer's website: build an order, check the price, place it, track it, change it | http://localhost:3000 |
| **Order service** | The restaurant's backend: owns the menu, prices, orders and the kitchen screen (SQLite database) | http://localhost:3001 |

The customer's browser only ever talks to the order builder, which passes requests on to the order
service. The order service is the single source of truth for prices: the total shown while building
is checked against what the restaurant would actually charge, and an order is never placed at a
price the customer was not shown.

## This is an MVP

This is a **minimum viable product**: a deliberately basic system that works end to end (build,
price, place, track, change, cancel, and a kitchen screen), designed to be extended rather than
finished. The core is built carefully because that is where mistakes cost money: exact pricing,
a price the customer is shown being the price they pay, safe retries, and an order lifecycle that
cannot be corrupted by two things happening at once. Everything around it is kept simple.

What that means in practice:
- **Basic by design:** no login or accounts, no real payments, no real kitchen integration (the
  kitchen advances orders by hand on its screen), a simple web interface, and a single local database.
  It is also not containerized yet: Docker was considered for a finalized version but is a
  lower-priority secondary piece, planned for after this proof of concept.
- **Not production-ready:** basic error handling is in place and is thorough in the pricing and
  ordering paths, where the assessment puts the emphasis, but a fuller system-wide version is not
  built, and security hardening is deferred (see the decisions log). Wider error handling, data
  integrity checks and database migrations are the first follow-ups in the next-steps list.
- **One requirement from the brief is not implemented: the written order description** (requirement 3,
  "on request, a written description of the order including quantity, size and toppings for each line
  item"). It was cut for time, in favour of pricing correctness and the order lifecycle. Customers can
  see their order's contents on every page, but nothing produces a written description on request. The
  data it needs is already returned by the API, and the plan is in
  [docs/next-steps.md](docs/next-steps.md#missing-requirement-the-order-description-not-implemented-due-to-time).
- **Known gaps are written down, not hidden.** Fixes, enhancements and anything cut to stay in the
  timebox are listed in [docs/next-steps.md](docs/next-steps.md), including the known issues to fix first.

## What it does

- **Pricing from the brief:** small $5, medium $7, large $12; basic toppings 8% and premium 11% of
  the pizza's price; 6.5% tax; tips as dollars or a percentage; promo codes `ILOVEPIZZA` (10% off) and
  `SAVE5` ($5 off an order over $20, not combinable with the other).
- **Price lock:** the prices a customer sees are held for 30 minutes. If the restaurant changes a
  price in the meantime, the customer is still charged what they were shown.
- **Checks before placing:** the service re-prices every order itself and re-validates promo codes.
  If anything differs from what the customer saw, the order is held and they confirm the new figures
  first. Very large tips are confirmed too.
- **Safe retries:** pressing Place order twice after a dropped connection places the order once.
- **Lifecycle:** Not Started → Started → Ready for Pickup → Delivered. A customer can change or
  cancel only while it is Not Started; the kitchen can cancel up to delivery.

## Running it

You need **Node 24** (`nvm use` reads `.nvmrc`) and npm.

```
npm install
npm run dev
```

That starts both programs with the demo menu loaded (seed data is on in `.env.development`) and
restarts them when code changes. Stop with Ctrl+C.

### Where to go

| Who | URL |
|---|---|
| **Customer:** build and place an order | http://localhost:3000 |
| **Customer:** an order's status page (you are taken here after placing) | http://localhost:3000/track/*order-id* |
| **Customer:** change an order that has not been started | http://localhost:3000/change/*order-id* |
| **Kitchen:** see incoming orders, start, mark ready, deliver or cancel | http://localhost:3001/kitchen |
| Menu with prices, as JSON | http://localhost:3001/menu |
| Health checks | http://localhost:3001/health, http://localhost:3000/health |

A quick way to try it: open the customer URL, add toppings (the total updates as you change the
order), then press **Place order**. Open the kitchen screen in a second tab and press **Start cooking** to watch the customer's
status page follow along. There is no login: the brief says authentication is out of scope, so the
kitchen screen is open to anyone who can reach the service.

### Sample orders

To try the kitchen screen and the status pages with something on them, place a set of sample orders
while the service is running:

```
npm run seed:orders
```

It places nine orders by calling the order service the way a customer and the kitchen would (so
every order goes through the real pricing and checks), and leaves them in every state: not started,
started, ready for pickup, delivered and cancelled. They are real orders that were entered by hand
through the app, and they include both promo codes, both kinds of tip, an order that was changed
and then cancelled, kitchen cancellations at two stages, and a very large tip that needs confirming. It prints each order's
status, total and a link to its status page. It refuses to add to a database that already has orders;
start clean with `npm run db:reset`, or add anyway with `npm run seed:orders -- --add`.

### Running the tests

```
npm test
```

Ports, the database file, logging, the other scripts (resetting the database, running one program
on its own) and troubleshooting are in [docs/configuration.md](docs/configuration.md).

## How the code is laid out

```
src/core/      The pricing engine: pure functions, no database or network, shared by service and browser
src/service/   The order service: database, menu snapshots, quote, placing/changing orders, kitchen screen
src/builder/   The order builder: web pages, and the relay to the order service
src/lib/       Small shared pieces: logging, start/stop handling, settings
db/            schema.sql and seed.sql
test/          Automated tests
docs/          Configuration, design decisions, assumptions, next steps
```

## Design write-up

### How is money represented and the total calculated? Where does pricing live, and why?

Money is **whole cents** and percentages are **whole basis points** (8% is `800`); pricing uses no floating
point. Each percentage (a topping from its pizza's price, a discount, tax, a percentage tip) is rounded half-up
to the cent when it is taken, by one helper in exact integer arithmetic. The total is built in a fixed order:
the subtotal (each line's base plus toppings, times its quantity), then promos, then tax on the discounted
amount, then the tip (flat, or a percentage of the bill after tax). A final check refuses to return any figure
that does not add up.

That logic is one pure module (`src/core`: lines, promos, totals) and it **runs in the order service only**. The
browser adds up whole-cent prices the service already worked out, for an instant "so far" figure, and shows the
service's totals, which refresh live as the customer edits. Why: **one source of truth**, so the total shown
cannot differ from the total charged, and the service **never trusts a price from the browser**:
- A quote is priced from a **menu snapshot** the service stored when it showed the menu (the exact prices, held
  30 minutes), found by token, never from numbers the browser sends.
- The page's figures are sent only as a *claim* to compare. Any difference (a changed price, a promo that no
  longer applies, a stale page, a bug, tampering) does not alter the charge: it **holds the order until the
  customer confirms the corrected figures**.
- Placing an order runs the same check **again**, inside the transaction that writes it, so what was verified
  is what is stored.

Running the same engine in the browser for instant totals is a possible later improvement ([next steps](docs/next-steps.md)).

### How does the design handle a new size, topping category or promo, including one with its own conditions and conflicts?

Menus, prices and promos are **data, not code**, so none of these touches the pricing engine.
- **A size, topping or category** is rows: a menu item plus a price rule (flat, or a percentage of the pizza's
  price), effective-dated so old orders keep what they paid. A category is only a label. The page and API build
  themselves from the menu.
- **A promo** is a row: code, kind, percent or amount, a minimum subtotal, `exclusive` (the default: it cannot be
  combined with another promo) and active dates. A promo with a condition of its own ("$2 off each large pizza")
  is one small registered **strategy** handed a copy of the priced order. The minimum, exclusivity, cap and dates
  apply to every kind.
- **Conflicts:** promos apply in the order entered, and one that cannot be combined with one already applied is
  refused with a message naming it ("SAVE5 cannot be combined with ILOVEPIZZA"). Finer rules would need a
  pairwise table (next steps).

Tests add a new size, topping category, flat-priced topping and promo kind with the engine unchanged.

### How does the order lifecycle work? A retry after a timeout, and a cancel as the kitchen starts

An order is **Not Started → Started → Ready for Pickup → Delivered**, plus **Cancelled** (added: the brief lets a
customer cancel, and a cancelled order must end up somewhere). The kitchen advances orders on its screen; the
customer can change or cancel only while Not Started; the kitchen can cancel up to delivery.

**A retry after a timeout.** The page makes an idempotency key for each attempt and keeps it. On a retry the
service looks the key up first, in the same transaction as the write: if the order was placed it returns **that**
order and writes nothing; if the first request never arrived it places it. The key is stored in the same
transaction as the order, so neither exists without the other. The same key for a different order is refused, and
it works after the 30-minute session has expired. *Guarantee: at most one order per key.*

**A cancel as the kitchen starts.** Both are conditional updates in a transaction that takes the database write
lock first: `UPDATE … WHERE id = ? AND status = <the status just read>`, which must change exactly one row. Writers
are serialized, so one commits first and the other sees the real status and is refused with it. The customer is
told the kitchen has started, never that it was cancelled while being cooked. The service ignores what the page
believes and re-reads the status. Changing an order uses the same guard plus a version number, and every change
records who made it and when. *Caveat: both orders of arrival are tested, one after the other, but not two truly
simultaneous requests; the guarantee rests on SQLite serializing writers.*

### What was cut or faked, and what would come next?

- **Not implemented:** the written order description on request (requirement 3), cut for time.
- **Basic or faked:** the kitchen is a screen with buttons; no login or payments; error handling is basic outside
  the pricing and ordering paths; no Docker; the pages' wiring was checked in a real browser by hand, not by
  permanent tests; idempotency keys are never cleaned up; no database migrations.
- **Next:** the order description; a full code review by AI and by a person; fuller error handling and data
  integrity; real-browser and end-to-end tests ([next steps](docs/next-steps.md)).

Separately, `next-steps.md` lists optional **enhancements** considered while shaping the schema (pre-built pizzas,
pricing and menu changes, more promotion types). They are not planned work.

### AI usage

I built this with **Claude Code (Sonnet 5.5)**, which wrote nearly all of the code, tests and documentation. I
directed it: we planned each piece before building it, checked in between major pieces, and kept a decisions log
([docs/decisions.md](docs/decisions.md)) of what we chose and why.

**Output I rejected.** Its first schema priced toppings by a rate held on the topping category (basic 8%, premium
11%). I rejected that and asked for a price table linked to each menu item, with a type (flat or percentage), so a
price change is a new row. The same review replaced its natural keys with surrogate ids, its pairwise
promo-conflict table with a single `exclusive` flag, and its tax setting with an effective-dated tax table.

**Output that was wrong.** Its price lookup compared timestamps as text, and `…:00Z` sorts after `…:00.000Z`, so a
scheduled price change took effect up to a second late. A test it had written caught it, and the fix was to make
the schema reject any other timestamp format. Separately, its dev setup served stale copies of the pages after they
were edited.

**What I verified myself rather than trusting.** I clicked through the running app in my browser instead of relying
on the passing tests (placing, tracking, changing and cancelling orders, and the kitchen screen). That found what
hundreds of passing tests had not: the change page showed no order. I noticed from the browser's network calls that
it asked only for the menu and never for the order, which pinned it on stale page files; we fixed that and I
re-tested it. I also checked that the prices the order screen shows match what I expected from the brief's
pricing rules, and entered nine orders by hand through the app, covering every status; the seed script replays
them through the API, and tests check it reproduces each one to the cent.

**Not yet done:** a systematic review of all the code by a person (see [next steps](docs/next-steps.md)).

## Documentation

- [Configuration and scripts](docs/configuration.md): settings, every npm script, the database settings, and troubleshooting
- [Design decisions](docs/decisions.md): why each major choice was made (money, pricing, price lock, order lifecycle, retries)
- [Assumptions](docs/assumptions.md): every place the requirements were ambiguous, and the call made
- [Next steps and cut list](docs/next-steps.md): the fixes and enhancements that would take this MVP further, what was left out to stay in the timebox, and known issues

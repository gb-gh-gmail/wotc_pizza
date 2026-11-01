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

**To run it:** see [Running it](#running-it) (`npm install`, then `npm run dev`), and
[Running the tests](#running-the-tests) (`npm test`).

The customer's browser only talks to the order builder, which relays to the order service. The service is the
single source of truth for prices, and an order is never placed at a price the customer was not shown.

## This is an MVP

A **minimum viable product**: deliberately basic, working end to end (build, price, place, track, change,
cancel, and a kitchen screen), and designed to be extended. The core is built carefully because that is where
mistakes cost money: exact pricing, the price shown being the price paid, safe retries, and an order lifecycle
that two things happening at once cannot corrupt. Everything around it is kept simple.

- **Basic by design:** no login, no real payments, no real kitchen integration (staff advance orders by hand), a
  simple web interface and one local database. Not containerized: Docker is a lower-priority piece for after this
  proof of concept.
- **Not production-ready:** error handling is thorough in the pricing and ordering paths and basic elsewhere;
  security hardening is deferred.
- **One requirement is not implemented: the written order description** (brief requirement 3). It was cut for
  time, in favour of pricing correctness and the order lifecycle. An order's contents are shown on every page and
  the API already returns what it needs; the plan is in
  [docs/next-steps.md](docs/next-steps.md#missing-requirement-the-order-description-not-implemented-due-to-time).
- **Known gaps are written down, not hidden**, in [docs/next-steps.md](docs/next-steps.md).

## What it does

- **Pricing from the brief:** small $5, medium $7, large $12; basic toppings 8% and premium 11% of the pizza's
  price; 6.5% tax; tips as dollars or a percentage; promo codes `ILOVEPIZZA` (10% off) and `SAVE5` ($5 off an
  order over $20, not combinable with the other).
- **Price lock and checks:** the prices a customer sees are held for 30 minutes. The service re-prices every
  order itself; if anything differs from what the customer saw, the order is held until they confirm the new
  figures. Very large tips are confirmed too.
- **Safe retries:** pressing Place order twice after a dropped connection places the order once.
- **Lifecycle:** Not Started → Started → Ready for Pickup → Delivered. A customer can change or cancel only while
  it is Not Started; the kitchen can cancel up to delivery.

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

To try it: open the customer URL, add toppings (the total updates as you edit), and press **Place order**. Open
the kitchen screen in a second tab and press **Start cooking** to watch the status page follow along. There is
no login (out of scope in the brief), so the kitchen screen is open to anyone who can reach the service.

### Sample orders

To try the kitchen screen and the status pages with something on them, place a set of sample orders
while the service is running:

```
npm run seed:orders
```

It places nine orders through the real service (so each goes through the real pricing and checks) and leaves
them in every state, including both promo codes, both kinds of tip, a changed-then-cancelled order, kitchen
cancellations, and a very large tip. They are orders that were entered by hand through the app. It prints each
order's total and status link, and refuses to add to a database that already has orders: start clean with
`npm run db:reset`, or add anyway with `npm run seed:orders -- --add`.

### Running the tests

```
npm test
```

673 test cases run in a few seconds, with nothing to start first. What they check and why, and what they do not
cover, is in [docs/testing.md](docs/testing.md).

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

## Assumptions and decisions

**Assumptions** are how we read something the brief left ambiguous or silent; **decisions** are rules we chose
to add. IDs in brackets point to [docs/assumptions.md](docs/assumptions.md) (the short list) and
[assumptions-detailed.md](docs/assumptions-detailed.md); the reasoning for larger choices is in
[docs/decisions.md](docs/decisions.md).

### Assumptions (how we read the brief)

- **Order of operations and rounding.** Subtotal, then promos, then tax on the *discounted* amount, then the tip.
  A percentage tip is of the whole bill (discounted subtotal plus tax); a dollar tip is added as entered. Every
  percentage is rounded half-up to the cent. (A8, A11)
- **"Over $20" is strict** and judged before the discount: exactly $20.00 does not qualify for `SAVE5`. (A9)
- **Promos apply in the order entered.** Both promos in the brief are exclusive, so `SAVE5` then `ILOVEPIZZA`
  keeps the first and refuses the second with a message. An invalid code is not applied, but the order is still
  priced. (A10)
- **A fifth status, `CANCELLED`.** The brief lets a customer cancel but names four statuses, so a cancelled order
  is kept, not deleted. Cancelling twice is not an error. (A1, A2)
- **The kitchen may cancel until delivery**; the brief limits only the *customer's* cancel. (A4)
- **A customer can change or cancel only while Not Started.** The brief gives that window for cancelling; we read
  changes the same way. A late attempt is refused and says the order's real status. (A3, A18)
- **Out of scope, as the brief says:** authentication and security hardening, real payments, a real kitchen.

### Decisions beyond the brief (rules we added)

- **A very large tip is confirmed first:** 50% or more of the bill, on a bill of $40 or more. (A15)
- **Sanity limits:** quantity 1 to 100, at most 50 lines, tips at most $500 or 100% and never negative, a topping
  at most once per pizza. (A12, A13)
- **The price shown is the price paid:** the menu is held for 30 minutes (a database setting). (A6, A14)
- **Nothing is charged that the customer has not seen:** any difference holds the order for confirmation. (A16)
- **A retry returns the original order**, not a second one. (A17)
- **A change is compared with the order as it stands** and saved only after the customer has seen it; every
  version is kept. (A20)
- **An AI assumption that review says to change:** a change is priced on a fresh menu, so an untouched pizza can
  change price. It should use the snapshot from when the order was placed, which is already kept. Not yet changed
  ([next steps](docs/next-steps.md)). (A19)
- **Extras for the kitchen screen:** an optional cancellation reason, and who changed each status and when. (A5, A7)

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
  integrity; real-browser and end-to-end tests. Optional product ideas (pre-built pizzas, pricing and menu
  changes, more promo types) are listed separately as enhancements. All in [next steps](docs/next-steps.md).

### AI usage

I used **Claude Code (Sonnet 5.5)** as my only AI tool. It wrote nearly all of the code, tests and documentation;
I directed it, planned each piece before it was built, and recorded the choices in [docs/decisions.md](docs/decisions.md).

**Rejected or fixed.** Its first schema priced toppings by a rate held on the topping category. I rejected that
for a price table linked to each menu item, so a price change is a new row. Its price lookup compared timestamps
as text, so a scheduled price change took effect up to a second late; a test caught it and the schema now
rejects any other timestamp format. Review also caught an assumption still unfixed: a changed order is priced on
today's menu, not the original ([next steps](docs/next-steps.md)).

**Verified myself.** I clicked through the running app instead of trusting the passing tests, and checked that the
prices on the order screen match what the brief's rules give. That found a bug the tests missed: the change page
showed no order, which I traced from the browser's network calls to stale page files.

A systematic review of all the code by a person has not been done yet.

## Documentation

- [API reference](docs/api.md): every endpoint with example `curl` requests and the real responses
- [Testing](docs/testing.md): how to run the tests, which invariants are tested and why, and what is not covered
- [Configuration and scripts](docs/configuration.md): settings, every npm script, the database settings, and troubleshooting
- [Design decisions](docs/decisions.md): an index of the major choices, each linking to its full record in [decisions-detailed.md](docs/decisions-detailed.md)
- [Assumptions](docs/assumptions.md): the short list of how we read the brief and the rules we added, linking to [assumptions-detailed.md](docs/assumptions-detailed.md)
- [Next steps and cut list](docs/next-steps.md): the fixes and enhancements that would take this MVP further, what was left out to stay in the timebox, and known issues

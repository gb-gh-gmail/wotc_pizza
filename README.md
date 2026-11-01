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

## Documentation

- [Configuration and scripts](docs/configuration.md): settings, every npm script, the database settings, and troubleshooting
- [Design decisions](docs/decisions.md): why each major choice was made (money, pricing, price lock, order lifecycle, retries)
- [Assumptions](docs/assumptions.md): every place the requirements were ambiguous, and the call made
- [Next steps and cut list](docs/next-steps.md): the fixes and enhancements that would take this MVP further, what was left out to stay in the timebox, and known issues

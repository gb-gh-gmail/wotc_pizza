# Cut list and next steps

Things deliberately left out to stay in the timebox, or planned for later. This feeds the
README's "what I cut / what I'd build next" section. Add to it as we go.

## Known issues to fix

> **Update (stale pages found).** While investigating "Change my order showed no pizzas" a cause
> that may also explain the two issues below was found and fixed (decisions D31): the dev servers
> kept serving an old copy of the pages after they were edited. With current code, loaded into a
> simulated browser against the real servers, the order page filled itself in correctly, Place order
> sent `POST /api/orders`, locked the page and moved on to the status page, and the change page
> showed the saved order. **Neither issue below reproduced there**, so both may have been caused by
> an out-of-date page; they stay listed until confirmed in a real browser, and the busy-overlay one
> still has genuine weaknesses worth fixing regardless (edits are not ignored while a request runs).

- **The busy overlay does not reliably lock the order page (reported, not yet investigated).**
  *Seen:* while "Place order" was running, the spinner/glass pane did not stop the page: a
  topping could still be clicked, and doing so put the page into its error state. *Expected:*
  while any request runs (check, apply, place, get new prices) nothing on the page can be
  clicked, typed into or tabbed to, and an edit can never disturb the request in flight.
  *Where to look first* (suspicions, none confirmed): `beginBusy` / `endBusy` in
  `src/builder/ui/app.js` (the page is made `inert` and a dialog shown after about 150 ms);
  the place-order path, which ends the busy state before opening the confirm dialog; and the
  edit handlers, which reset the status and the retry key even if a request is in flight, so the
  response that then arrives is applied to a page that has changed underneath it.
  *Fix direction:* make "busy" a single flag that the edit handlers also respect (ignore edits
  while busy), have each response check that the order is the one it was sent for and drop
  itself if not, and add a jsdom test that clicks a topping, a tip and a promo during each kind
  of request and asserts nothing changes. Found by hand because the page has no browser tests;
  this is exactly what the jsdom tests listed below are for.

- **"Place order" did not finish and never reached the status page (reported, not yet
  investigated; to be fixed once the order-update page is built).** *Seen:* pressing Place order
  on the builder page never completed: the customer was not taken to `/track/<id>`. *Expected:*
  the order is placed and the browser moves to the status page. *Known to work:* the same
  journey on the real running processes through the builder's own endpoints (menu → quote →
  place → retry → status page → kitchen), and every service and relay test; so the fault is
  most likely in the page's wiring (`placeOrder` in `src/builder/ui/app.js`) or its interaction
  with the busy overlay above, which the tests do not exercise. *Things to check:* the browser
  console and network tab at the moment of the click (does `POST /api/orders` leave the browser,
  and what comes back?); an exception thrown between `beginBusy` and the request, which would
  leave the page locked with a spinner; that `trackPath` is read from the response and that
  navigation is not blocked while the page is inert; and whether this and the previous issue are
  one cause. *Fix direction:* wrap the whole place flow so any failure ends the busy state and
  shows a message (never an endless spinner), and add a jsdom test that clicks Place order
  against a stubbed service and asserts the move to the status page.

## Order builder UI
- **Premade pizzas with customizations.** Offer named pizzas (e.g. a house special) as a
  starting point that the customer can then add toppings to or remove toppings from. Needs a
  data model for a premade pizza (a size-agnostic topping list on the menu) and price rules
  for removing a topping that is part of the pizza. Today the customer builds every pizza
  from a size plus toppings.
- **"Add" and a cart.** Choose an item, customize it, add it to a cart, and edit the cart
  before sending. Today the page shows the pizzas being built directly, with no separate
  add-to-cart step.
- **Keep the draft order across a page refresh** (it is held only in memory today).
- **Real-browser tests of the pages** (next after the infrastructure; prefer this to jsdom). Driving the
  installed Chrome through `puppeteer-core` against the real servers already verified that the change
  page fills itself from the saved order and that Place order reaches the status page, with no console
  errors (run by hand from a scratch script); it should become a permanent test suite. jsdom is a
  weaker substitute: it cannot load the pages as ES modules, so it misses a broken import. The
  scenarios to cover are listed next. The page's decisions are
  tested without a browser (`logic.js`: tip parsing, building the quote request, reading the
  response, when "Place order" is enabled, the countdown), as is everything the page displays
  from the service. Not yet covered is the wiring in `app.js`: adding, removing and changing
  pizzas and toppings; every edit marking the total as out of date and disabling "Place order";
  "Check my total" and promo "Apply" showing the quote; a removed promo clearing its box with
  the notice and the new total; "Accept updated total" re-enabling the button; the timed-out
  dialog at expiry and renewing the session while keeping the order; and failure messages. For
  changing an order: the page filling itself from the saved order, the comparison table, and above
  all the **alert when the order moves on mid-edit** (the "locked" dialog, the disabled Save, the
  link back) and the status page dropping *Change my order* when the status changes. The decisions
  behind these (`watchVerdict`, `compareToCurrent`, `linesFromOrder`) are tested; the wiring is not.

## Pricing and promos
- **More coupon types.** The promo engine is built for this (D24): a promo is a database row
  plus a registered strategy that receives a copy of the priced order, lines included. What
  is left to build is the coupons themselves and the plumbing around them: line-specific
  rules such as "$2 off each large pizza", "free topping", "buy one, get one half off" or
  "10% off premium toppings", each as one new strategy; a place to store a promo's own
  parameters (which size or topping it targets) rather than reusing the generic amount and
  percent columns; reporting a discount per line instead of one total; promo validity windows
  (the `starts_at` / `ends_at` / `active` columns exist but the engine does not read them
  yet); and promo management without a database edit.
- **Combination rules finer than "exclusive".** Today a promo either cannot be combined with
  anything or can be combined with everything. "A conflicts with B but both work with C" would
  need a pairwise rule table.

## Orders
- **The kitchen simulation:** a timer that advances orders automatically, instead of the manual
  buttons on the kitchen screen.
- **Idempotency keys:** they are never cleaned up, so the `idempotency_keys` table only grows; add
  an expiry (a key only needs to outlive the longest realistic retry). Also not yet tested: two
  *simultaneous* requests with the same key (reasoned safe, since the key is a primary key and
  writes take the database lock first, but only sequential retries are tested).
- **Per-line price protection on a change:** an unchanged pizza is re-priced on today's menu when
  an order is changed (A19). If the restaurant wants customers to keep the price they originally
  agreed for pizzas they did not touch, each revision line would need to carry and honour its
  original price.
- **Show the revision history** to the customer or the kitchen (what changed, when); it is kept
  in `order_revisions` but only the first total and the count are surfaced.
- **The kitchen screen could flag a changed order** ("changed since placed") so staff notice a
  recent edit.

## Order service
- **Expose the status history** (`order_status_events`: who changed the status, and when) in
  an API and on the pages; it is recorded but not shown anywhere.
- **Security hardening** (D22): authentication for the kitchen routes, response security
  headers including a Content-Security-Policy, rate limiting on order submission, a review of
  logged fields.

## Error handling (planned for after the infrastructure is in place)
A pass over the whole system so that every failure ends in a clear message to the customer
and a useful log line, rather than a stack trace or a blank page:
- **Bad input** everywhere: malformed or oversized request bodies, wrong types, unknown
  routes and methods, with consistent error shapes (a stable `error` code plus a plain-language
  `message`) instead of Fastify's defaults.
- **Database trouble:** the database unavailable, locked for too long, read-only, out of disk,
  or the file missing or corrupted; a schema version this build can't use. The customer sees
  "we can't take orders right now" and the service reports unhealthy on `/health`, instead of
  a 500.
- **Corrupted or inconsistent data:** a menu item with no price or two prices, a missing tax
  rate or setting, a snapshot whose JSON is unreadable, an order with an unknown status. Each
  should fail safe (refuse to price rather than guess) with a message and an alert-worthy log.
- **The builder when the order service misbehaves:** it already answers 502/504 for an
  unreachable or slow service; still needed are retries with back-off for safe requests and
  messages in the page for every failure mode.
- **Unexpected exceptions:** a last-resort handler that logs with a request id, returns a
  generic message, and never leaks internals.

## Data
- **Schema migrations.** Today a database from an older schema is refused and the dev database
  is simply recreated (`npm run db:reset`). That is fine before launch but would lose orders in
  production; ordered, versioned migrations that upgrade a database in place are needed first.
- **Take an item off the menu mid-session** (an ingredient runs out). A customer holding a
  menu snapshot can currently still order an item deactivated after they loaded it; a rule to
  refuse unavailable items at order time, with a message, may be wanted.

## Operations
- Docker images and `docker compose up` for both processes, and confirming real signal
  handling (SIGTERM/SIGHUP) on Linux; Windows can't deliver them to a child process.

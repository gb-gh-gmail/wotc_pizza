# Cut list and next steps

Things deliberately left out to stay in the timebox, or planned for later. This is an MVP (see the
[README](../README.md)): it is a basic system that works end to end, with the fixes and
enhancements that would take it further listed here.

- **Missing requirement** is anything the brief asks for that is not built. There is one.
- **Full code review** (by AI and by a person) comes straight after it.
- **Known issues to fix** are things that are wrong or weak today.
- **Error handling, transitions and data integrity** is the first follow-up. A basic version is in
  this revision; the fuller version is a secondary concern to the core ordering and pricing the
  assessment asks for.
- **Enhancements** are future provisioning: ideas that were taken into account while shaping the
  schema and the system, some partly provisioned, none fully built.
- The sections after that are smaller items that were cut or would come next.

## Missing requirement: the order description (not implemented, due to time)

**The brief (requirement 3):** *"On request, the program produces a written description of the order
including quantity, size, and the list of toppings for each line item."*

**Status: not implemented.** It was cut to stay within the timebox, in favour of what the assessment
puts first: correct pricing and a defensible order lifecycle. It is the one requirement in the brief
that is not met. (The other requirements, 1, 2 and 4 to 6, are built. Requirement 6 also asks for an
explanation of the extensibility design in the write-up, which is still to be written.)

**What exists today.** A customer can *see* what is in their order: the order page shows each pizza
with its quantity, size, toppings and price as it is built, the change page opens with "Your order
right now", the status page lists the items, and the kitchen screen lists each order's contents. What
does not exist is a written description produced *on request*: no "Describe my order" action, and no
description text in the API.

**What it would take (small; the data is already there).** The order API already returns every line's
quantity, size and toppings, with their menu labels.
- A pure function, `describeOrder(lines)`, in `src/core`, returning plain text in the shape of
  *"2 × Large pizza with Pepperoni and Bacon; 1 × Small pizza with no toppings"*, with the wording
  rules settled (no toppings, one, two, several; quantity of one against more than one; the menu's
  own labels).
- The same text returned in the API's order and quote responses as a `description`, so any client can
  show it.
- A **Describe my order** button on the order page and the change page that shows the text (and lets
  the customer copy it), and the same text on the status page.
- Unit tests for the wording and its edge cases, and a check through the API.

**Why it was safe to defer.** It is presentation only: it does not touch pricing, the order lifecycle or
anything stored, so adding it later cannot put a customer's money at risk.

## Full code review, by AI and by a person (not yet done)

**Status: not done.** Most of this code was written with AI assistance. It has been checked by 673
automated tests, by exercising the running system (including in a real browser), and by the author trying
the app by hand and finding real faults that way. What has not happened is a **systematic review of the
whole codebase**, read critically, by anyone. That is the next piece of verification, and it is what turns
"it passes its tests" into "it has been read and is believed correct."

**Approach: two independent reviews, then compare.**
1. **An AI review with fresh context.** A reviewer that did not help write the code and has no memory of
   the reasoning behind it, so it cannot simply agree with the design. It is asked to find bugs, risky
   assumptions and drift between the docs and the code, not to comment on style.
2. **A person reading the same code.** Focused on what AI-written code tends to get wrong: logic that is
   plausible but subtly wrong; confident comments that no longer match what the code does; more machinery
   than the problem needs; and tests that assert what the code *does* rather than what it *should* do.
3. **Compare the two.** A problem both find is real. A problem only one finds is investigated, not assumed.
   Each finding is written down with its severity and outcome (fixed, accepted with a reason, or not a
   problem), and the docs are corrected where the review shows them to be wrong.

**Scope** (about 5,200 lines of source, scripts and SQL, and 5,000 lines of tests), in priority order:
- **The money and ordering paths first:** `src/core` (pricing, promos, totals: 676 lines), the order
  service's placing, changing and quoting (`src/service/orders`, `src/service/quote`), menu snapshots, and
  the schema's constraints and triggers. Rounding at the boundaries, promo exclusivity and thresholds, the
  price lock, and what exactly is written in one transaction.
- **Concurrency and retries:** every transaction boundary, every conditional update, the idempotency
  fingerprint and its replays. This is where "tested one request after another" could hide a gap.
- **Error paths:** what a client receives when something fails (the known leak of internal messages is in
  the error-handling section), unhandled promise rejections, and failure half-way through a write.
- **The browser code**, especially `src/builder/ui/app.js` (848 lines, the largest file, whose wiring has
  no automated tests): the state machine, stale or overlapping answers, focus and dialogs.
- **Queries and schema:** confirm every query uses bound parameters and that the schema's constraints match
  what the code assumes.
- **Docs against code:** every claim in `decisions.md`, `assumptions.md`, `configuration.md` and the README
  checked against what the code actually does.
- **The tests themselves:** do they fail when they should? Break a rule on purpose (a mutation check, as
  was done once for the layering test) and confirm a test notices.
- **Dependencies and configuration:** what is installed and why, and the defaults.

**Outcome:** written review notes with the findings and what was done about each, the fixes themselves, and
corrected docs. It also feeds the AI usage note: what the AI got wrong, and how it was caught.

## Known issues to fix

- **Overlay modal while submitting an order (and renewing the session).** *Wanted:* while a request
  that must not be disturbed is running (Place order, Save changes, Get new prices) the whole page is
  blocked behind an overlay with a spinner: nothing can be clicked, typed into or tabbed to, and an edit
  can never disturb the request in flight. (Quote updates are deliberately *not* modal now: totals update
  live and quietly as the customer edits, D27.) *Partly addressed:* the edit handler now ignores edits
  while such a request is running, and last-one-wins covers quote answers; what remains is the test below. *Seen once:* during Place order the overlay
  did not stop the page: a topping could still be clicked, and doing so put the page into its error
  state. That was reported before a stale-page fault was fixed (decisions D31), and the overlay
  has not been seen failing since, but the weaknesses behind it are still in the code and the
  behaviour has no automated test. *Where it can go wrong:* `beginBusy` / `endBusy` in
  `src/builder/ui/app.js` make the page `inert` and show a dialog after about 150 ms, but the edit
  handlers (`edited()`) do not check whether a request is running, so an edit made in that window
  resets the status and the retry key, and the response that then arrives is applied to a page that
  has changed underneath it; and the place-order flow ends the busy state before it opens the
  confirm dialog. *To do:* make "busy" one flag that the edit handlers respect (ignore edits while
  busy); have each response check it still matches the order it was sent for and drop itself if
  not; and cover it in the real-browser tests (Enhancements, item 6) by clicking a topping, a tip
  and a promo during each kind of request and asserting nothing changes.

- **Make sure every page always shows the latest version.** Pages and scripts are now re-read
  from disk on every request and sent with `Cache-Control: no-store` (decisions D31), which fixed
  the stale pages seen in development. What is left to make this dependable beyond one developer's
  machine: confirm it for *every* page and script in a real browser (the builder, the change
  page, the status page, the kitchen screen, and the shared `logic.js` module they import, since a
  stale module next to a fresh page fails to load at all); in production the start-up copy is
  served, so deploys need a version in the page address or a version stamp shown on the page and
  in `/health`, so what is running can be told at a glance; and a page already open when a new
  version is deployed (the kitchen screen is left open all day) should notice and offer to reload,
  rather than carrying on with old code against a newer service. Add a real-browser test that
  edits a page, reloads, and sees the change.

## Error handling, transitions and data integrity (first follow-up; secondary to the core)

The first thing to do after the known issues, because this is where a failure costs the most: it
decides whether a customer sees a clear message instead of a blank page, and whether an order, once
taken, can be trusted.

**A basic version is in this revision; the fuller version is deliberately a secondary concern.**
The assessment brief says to prioritize *correct pricing and a defensible order lifecycle over
breadth of features*, and that *an honest cut list beats a broken feature*. So the effort went into
making the ordering and pricing paths fail safe, with basic error handling everywhere else, and the
better, system-wide implementation is listed here rather than half-built.

### Error handling

**In place now (basic):**
- **Money and ordering paths fail safe.** An order that is invalid is refused with every problem
  listed (422); a stale, expired or unknown menu session is refused (409); anything that does not
  match what the customer saw is held for confirmation; a change to an order that has moved on is
  refused with the real status; a missing retry key is a 400. Each has a stable `error` code and a
  plain-language `message`. Every write is all-or-nothing, and the pricing engine throws rather than
  return a figure that does not add up.
- **Inconsistent menu data or settings** (an item with no price or two, no tax rate, a missing or
  out-of-range expiry setting) make the menu unavailable (503) instead of guessing, and nothing is
  stored or sent.
- **Malformed requests** (bad JSON, a missing or wrongly-typed field) are rejected with a 400, and
  type coercion is off so `"533"` is not quietly accepted as a number.
- **The database:** `/health` reports 503 when it does not answer; a database from another schema
  version is refused at start-up with a message that says what to do; a failure at start-up shuts
  the process down cleanly through the same path as any other stop.
- **The builder and pages:** the builder answers 502 or 504 with a plain message when the order
  service is unreachable or slow; the pages time a request out after 15 seconds and show a message
  (including "we couldn't confirm your order was placed; trying again will not place it twice")
  instead of an endless spinner.

**Not yet (the fuller version).** Checked against the real responses:
- **An unexpected server error leaks internals.** Today the client receives Fastify's default 500
  body, which includes the internal error message and the database driver's error code (for example
  `ERR_SQLITE_ERROR` with the SQL error text). It should return a generic message and a request id,
  and log the detail.
- **Error responses have two shapes.** Our own errors are `{ error, message, ... }`; validation errors,
  unknown routes and unexpected failures use Fastify's default `{ statusCode, code, error, message }`.
  They should share one shape with a stable `error` code, and the page should read it.
- **Bad input everywhere:** oversized request bodies; unknown routes and methods (they return a 404,
  not a "method not allowed"); consistent messages a customer can act on.
- **Database trouble** beyond "does it answer": locked for too long, read-only, out of disk, or the
  file missing or corrupted. The customer should see "we can't take orders right now", and the
  service should report unhealthy, instead of a 500.
- **Corrupted or inconsistent data** beyond the menu: a snapshot whose JSON is unreadable, an order
  with an unknown status. Each should fail safe with a message and an alert-worthy log.
- **The builder when the order service misbehaves:** retries with back-off for safe requests, and a
  message in the page for every failure mode.
- **Unexpected exceptions:** a last-resort handler that logs with a request id, returns a generic
  message, and never leaks internals (the first point above).

### Transitions
- **Data transitions: schema migrations.** Today a database from an older schema is refused and the
  development database is simply recreated (`npm run db:reset`). That is fine before launch but
  would lose orders in production; ordered, versioned migrations that upgrade a database in place
  are needed first.
- **Order status transitions** are explicit and guarded already (only the listed moves are allowed,
  and every change is checked against the real status inside a transaction, so two things happening
  at once have exactly one winner). Still to consider: noticing orders stuck in a status for too long
  (the kitchen never moved them on), and what happens to open orders if the kitchen side is down.

### Data integrity
The database enforces what it can (foreign keys, check constraints, no-overlap triggers, one
canonical timestamp format, a pinned schema version) and orders are written all-or-nothing. Not yet
done:
- **Check the file at start-up** (SQLite's own integrity and foreign-key checks) and refuse to
  serve orders from a damaged database, with a clear message.
- **A consistency audit of stored orders:** each order's total equals its parts, its lines add up
  to its subtotal, its current version matches its latest revision, and its status matches the last
  event in its history. The pricing engine already refuses to return a figure that does not add up;
  this would check what was stored.
- **Backups and restore** of the database file, done safely while the service is running.
- **A defined response when a problem is found:** stop taking orders, keep serving status reads,
  raise an alert, and say what to do.

## Enhancements (future provisioning)

Ideas considered while building the schema and the system, so that they could be added without
reworking the core. Each entry says what is **already provisioned**, what is **not built**, and
what to **think about**. Nothing here is a commitment or an order of priority.

### 1. Pre-built pizzas (customizable), and an add-to-cart flow
Named pizzas (a house special) as a starting point the customer can then customize by adding or
removing toppings, chosen with an "add" step into a cart that can be edited before sending. Today
every pizza is a size plus toppings, built directly on the page.
- **Provisioned:** items have a type held in a lookup table (`menu_item_types`), so a new kind of
  item such as "pizza" is a row, not a schema change; menus, categories and items are data; a price
  is either a flat amount or a percentage of the base pizza's price; an order line already records
  its size and each topping with the price row it was charged from, so a pre-built pizza can be
  stored as a line with its preset toppings; promo rules are handed the priced lines.
- **Not built:** somewhere to hold a pizza's preset toppings on a menu; price rules for it; the
  page flow to choose one and customize it; the cart.
- **Think about:** does removing a preset topping lower the price, or not; is a pre-built pizza
  priced as its base plus toppings (so a topping price change moves it) or at a fixed price; and
  what happens when one of its ingredients is unavailable (item 4).

### 2. Pricing changes
- **Provisioned:** prices are effective-dated rows (flat or percentage), changed by closing a row
  and adding a new one, never by editing one in use; tax rates work the same way and cannot overlap
  (enforced by a trigger); a customer holds a **price lock** on the menu they were shown for 30
  minutes, so a change mid-session does not change what they pay (D23); every order line records
  the price row and the cents charged, and every revision of a changed order keeps its prices;
  timestamps are held to one enforced format so a scheduled change takes effect at the exact instant.
- **Not built:** any way to schedule a change except editing the database; bulk repricing (today
  repricing all premium toppings is one row per topping; pricing by category was noted as an
  escape hatch in D5); telling customers a price is about to change.
- **Think about:** *per-line price protection on a change.* Today an unchanged pizza is re-priced
  on today's menu when an order is changed (assumption A19). Keeping the price a customer originally
  agreed would mean each revision line carrying and honouring its original price. Also, prices
  deliberately have no overlap trigger (several menus can coexist, D5), so the service refuses to
  quote an item that has zero or two prices in effect rather than guess.

### 3. Changes to menus and menu items
- **Provisioned:** menus have a name, an active flag and an effective window, and two active menus
  cannot overlap (a trigger), so "which menu applies now" has exactly one answer; items belong to a
  menu and have active flags and sort order; each order records its menu and the exact menu session
  it was priced from; the change page drops anything no longer on the menu and tells the customer.
- **Not built:** tooling to create a new or seasonal menu (it is database edits today), or to copy
  a menu as a starting point; any history of renamed items.
- **Think about:** two menus at once (lunch and dinner) is deliberately blocked by the overlap
  trigger, so supporting it means changing that rule; and a customer part-way through an order when
  the menu changes keeps their menu session until it expires, then must reload.

### 4. Running out of an ingredient (a concern; not provisioned)
Needing to take an item off the list temporarily is not provisioned, only thought about.
- **Today:** items have an `active` flag, which is a blunt on/off switch with no reason and no end
  time, and a customer who loaded the menu before an item was switched off can still order it until
  their menu session expires.
- **Think about:** a *temporary* "unavailable until" state rather than the permanent active flag;
  refusing an unavailable item at order time with a clear message, even for a customer holding an
  older menu session; what to do about orders already placed that contain it (the kitchen
  substituting, telling the customer, cancelling); how the kitchen marks something unavailable
  (a button on its screen); and the knock-on effects on pre-built pizzas that include it and on
  promos that target it.

### 5. More promotion types
- **Provisioned:** a promo is a database row plus a registered strategy. Each strategy is handed a
  **copy of the priced order** (every line's size, toppings, unit and line prices, and the
  subtotal), so a line-specific coupon such as "$2 off each large pizza", a free topping, buy one
  get one half off, or "10% off premium toppings" is one new strategy with no change to the pricing
  engine. The generic rules apply to every kind: a minimum subtotal (strictly over), the
  `exclusive` flag (cannot be combined with another promo), a cap at the subtotal, and validity
  windows (`active`, `starts_at`, `ends_at`, read and enforced). A refused code comes back with a
  reason in plain words.
- **Not built:** a place to store a promo's own parameters (which size or topping it targets)
  rather than only a percent, an amount and a minimum; reporting a discount per line instead of one
  amount per promo; promo management without editing the database.
- **Think about:** combination rules finer than "exclusive" ("A conflicts with B but both work with
  C") would need a pairwise rule table; and usage limits ("once per customer") need some notion of
  who the customer is, which the brief puts out of scope.

### 6. A fuller UI test package
- **Provisioned:** the page's decisions live in a module with no browser in it (`logic.js`) and are
  unit-tested (tip parsing, building the quote request, reading the response, when Place order is
  enabled, the countdown, the change comparison, the mid-edit lock verdict); everything the pages
  display from the service is tested through the service. Driving the installed Chrome headlessly
  (`puppeteer-core`) from a scratch script already verified that the change page fills itself from
  the saved order, that Place order reaches the status page, and that the "Place a new order" link
  works, with no console errors, but those scripts are not part of the repository.
- **Not built:** a permanent real-browser suite. Prefer a real browser to jsdom: jsdom cannot load
  the pages as ES modules, so it misses a broken import. Scenarios to cover: adding, removing and
  changing pizzas and toppings; every edit marking the total out of date and disabling Place order;
  Check my total and Apply showing the quote; a removed promo clearing its box with the notice and
  the new total; Accept updated total re-enabling the button; the timed-out dialog at expiry and
  renewing the session while keeping the order; failure messages; that the overlay really blocks the
  page while a request runs (Known issues); for changing an order, the page filling itself from the
  saved order, the comparison table and above all the **alert when the order moves on mid-edit**
  (the locked dialog, the disabled Save, the link back) and the status page dropping *Change my
  order* when the status changes.
- **Think about:** keyboard and screen-reader use (focus after dialogs), a phone-sized screen,
  other browsers, and running the suite automatically on every change.

### 7. End-to-end integration tests
- **Provisioned:** the relay tests already run the real order service and builder against each
  other over real HTTP, and journeys such as place, retry, change, the kitchen starts the order and
  the late save is refused have been walked by hand on the real processes (not kept in the repo).
- **Not built:** a permanent suite that starts both real processes (and a browser) and runs whole
  journeys, including cancel racing the kitchen, expiry, and two windows editing one order.
- **Think about:** controlling time (the service accepts a clock in tests, but a separate process
  needs a hook or a very short expiry setting); injecting failures (service down or slow, database
  locked); a known seeded database for each run; and running it under Docker.

### 8. Idempotency key (and related) clean-up
- **Today:** a key is stored with each placed or changed order and never removed, so the
  `idempotency_keys` table only grows; expired menu sessions are removed only when the service
  starts, so a long-running service never cleans them until it restarts. Order revisions are kept on
  purpose.
- **To do:** give keys an expiry (a key only needs to outlive the longest realistic retry, a day
  would be generous) and run the clean-up on a schedule for keys and menu sessions.

### 9. A full review of idempotency and integration
A deliberate review of every place a request can be repeated or can arrive out of order, ending in a
written account and tests for any gap. Questions to answer:
- Which write paths are safe to repeat, and how? Placing (by key), changing (by key, bound to the
  order), cancelling (by state), the kitchen's advance (by the status it expects), quoting (it
  writes nothing).
- What does a repeat return? A repeated place returns the order as it is now; a repeated change
  returns the order as it is now, not as it was when first answered.
- What does the key's fingerprint cover? Today the menu session and the order; the claimed figures
  and confirmations are deliberately left out. Is that right in every case, such as the same key
  with a different large-tip confirmation?
- Two identical requests at the same instant: reasoned safe (the key is a primary key and writes
  take the database lock first) but only tested one after another.
- The page's key handling (kept across a network failure, new after an edit or expiry) confirmed in
  a real browser; and timeouts across the hops (the page waits 15 seconds, the builder 8 seconds
  for the service), where a timeout leaves the outcome unknown and relies on the retry.
- How all this behaves once the key clean-up (item 8) exists.
Pairs with item 7.

## Order builder UI
- **Keep the draft order across a page refresh** (it is held only in memory today).

## Orders
- **The kitchen simulation:** a timer that advances orders automatically, instead of the manual
  buttons on the kitchen screen.
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

## Operations
- **Docker: not implemented.** The project has no Dockerfile or `docker compose` setup yet. It was
  considered as part of a finalized version (images for the two programs and one command to bring
  both up, with the database on a volume) but deliberately placed at lower priority, as a secondary
  piece to do after this proof of concept. Groundwork already exists: the service uses Node's
  built-in SQLite (nothing native to compile), settings come from environment variables, `HOST`
  can be set to `0.0.0.0`, the database path is configurable, and both programs shut down cleanly
  on SIGTERM. Still to confirm when it is built: real signal handling (SIGTERM and SIGHUP) on
  Linux, which cannot be tested on Windows because it cannot deliver them to a child process.

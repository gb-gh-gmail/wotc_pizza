# Assumptions and decisions: detailed

The full entries. For the short list, see [assumptions.md](assumptions.md). Every place the requirements
were ambiguous or silent, or where we added a rule of our own, with the call we made and where it is
implemented. The reasoning behind larger choices is in [decisions-detailed.md](decisions-detailed.md).

Two kinds of entry, kept apart: **assumptions** are how we read an ambiguous or silent brief; **decisions
beyond the brief** are rules we chose to add. IDs are stable because other documents cite them.

## Assumptions (how we read the brief)

<a id="a1"></a>
### A1. A fifth status, `CANCELLED`, exists

The brief names four statuses (Not Started, Started, Ready for Pickup, Delivered) yet
requires that an order can be cancelled. We model cancellation as a distinct terminal
status rather than deleting the order, so the order ID still resolves (a customer who
retries a cancel or checks status gets a clear answer) and there is an audit trail.
The customer may cancel only from Not Started (the kitchen can cancel later; see A4); see the
state machine in `decisions-detailed.md` D8.
*Implemented in:* `orders.status` CHECK constraint (`db/schema.sql`), order state machine
(`src/service/orders/state.ts`).

<a id="a2"></a>
### A2. Cancelling is idempotent

Cancelling an already-cancelled order returns success with the same result rather than an
error, because mobile clients retry after timeouts and cannot tell whether the first
request landed.

<a id="a3"></a>
### A3. A customer cancelling or editing an order that has moved past Not Started is refused

The response is a 409 that includes the order's current status. The service checks the real
status at the moment of the request, so a customer looking at a stale page cannot cancel an
order the kitchen has just started.

<a id="a4"></a>
### A4. The kitchen can cancel at any time before delivery; the customer only before the
kitchen starts

The brief only says the *customer* may cancel until the kitchen starts. Restaurant staff
are not bound by that: they may need to scrap an order that is already being made (out of
an ingredient, a burnt pizza). So the kitchen may cancel from Not Started, Started or Ready
for Pickup. Nobody can cancel a Delivered order.

<a id="a8"></a>
### A8. Order of operations

Subtotal = sum of the lines. The discount comes off the
subtotal. Tax applies to the *discounted* subtotal. A percentage tip applies to the total
bill, meaning discounted subtotal plus tax; a dollar tip is added as entered. The brief
doesn't say whether tax or tip comes first or what a percentage tip is "of"; this is the
reading that matches "tip as a percentage of the total bill".

<a id="a9"></a>
### A9. "Over $20" is strict and judged before the discount

SAVE5 needs the pre-tax
subtotal to be more than $20.00; exactly $20.00 does not qualify. The test uses the subtotal
before any promo comes off.

<a id="a10"></a>
### A10. Promo codes are applied in the order entered

A code that is unknown, whose
conditions aren't met, or that can't be combined with one already applied is *not applied*,
with a message saying why; the order is still priced. Both promos in the brief are
exclusive, so entering SAVE5 and ILOVEPIZZA keeps the first and refuses the second. A code
that didn't apply doesn't block a later one.

<a id="a11"></a>
### A11. Rounding is half-up to the whole cent, at each percentage

(topping prices, a
percentage discount, tax, a percentage tip). See `decisions-detailed.md` D9.

<a id="a18"></a>
### A18. An order can be changed by its customer only until the kitchen starts it

Not Started is
the only status in which the pizzas, tip or promos can change (the same window as customer
cancellation). The kitchen cannot edit an order. Once the status moves on, the option disappears
from the status page, a customer part-way through a change is alerted within a few seconds, and
the service refuses a late save, saving nothing. A change racing the kitchen starting the order
has exactly one winner.

## Decisions beyond the brief (rules we added)

<a id="a5"></a>
### A5. A cancellation can carry an optional reason

Free text, up to 200 characters, never required. Not specified in the brief; added so the
kitchen screen can show why an order was cancelled. A retried cancel does not overwrite
the first reason.

<a id="a6"></a>
### A6. The price a customer is charged is the price on the menu they were shown

If the restaurant changes a price while a customer is building an order, that customer is
still charged the price they saw, as long as they submit within the menu's validity window.
After that window, or if their totals disagree with the service's, they are shown the
corrected prices and must confirm before the order is accepted. Rationale in `decisions-detailed.md`
D23.

<a id="a7"></a>
### A7. Every status change records who made it and when

`customer`, `kitchen` or `system`, with a UTC timestamp, kept in an audit table. Not
required by the brief; it makes cancel-versus-start races explainable after the fact.

<a id="a12"></a>
### A12. Sanity limits

Quantity 1 to 100 per line; at most 50 lines; a tip of at most $500
or 100%. These stop typos, not real orders; they are constants in `src/core/pricing.ts`.

<a id="a13"></a>
### A13. A topping appears at most once per pizza

Two bacon on one pizza is refused; bacon
on two different pizzas is fine.

<a id="a14"></a>
### A14. Customers have a fixed time to finish an order

After loading the menu a customer
has `user_menu_expiry_seconds` (30 minutes by default, a database setting) to submit, with
the deadline shown on screen and a dialog when it passes.

<a id="a15"></a>
### A15. A very large tip is confirmed before the order is placed

A tip is "very large" when
it is **50% or more of the bill** (discounted subtotal plus tax, the same "total bill" a
percentage tip is taken from) **and the bill is $40.00 or more**. A bill under $40.00 is exempt
however large the share, because a big share of a small order is still a small sum. Exactly 50%
counts; exactly $40.00 is not exempt. The customer sees the tip and the bill and must confirm
it ("Yes, the tip is correct"). Tips can never be negative, and are capped at $500 or 100%.
The brief doesn't mention any of this; it guards against a slip of the finger such as a stray
zero. The service flags the tip, and placing (or saving a change to) an order with an
unconfirmed large tip is held until the customer confirms.

<a id="a16"></a>
### A16. Placing an order is only ever the customer's own, checked and confirmed submission

The service never charges a figure the customer has not seen: it prices the order itself and
holds it (placing nothing) if anything differs from what the page showed, if a promo code no
longer applies, or if a very large tip has not been confirmed. The customer then either accepts
the updated figures, which places the order, or cancels back to the order screen. An order
that was placed is never silently changed afterwards. A promo code that was *never* valid (a
typo) that is still in the order at submit time also holds it, rather than being quietly
dropped, so the customer is never told one thing and charged another.

<a id="a17"></a>
### A17. A retry returns the original order, not a second one

If a connection drops while an
order is being placed, the customer can press Place order again: the page re-sends the same
request key and the service answers with the order it already placed. Two deliberate orders are
two different keys.

<a id="a19"></a>
### A19. A change is priced on today's menu, and shown against the order as it stands

*An assumption the AI made, not one the brief or the author asked for. Review concluded it is probably
wrong: a change should be priced from the menu snapshot taken when the order was placed, so the customer
keeps the prices they were shown (the same principle as A6). Not yet changed, and the details are
deferred (most likely the snapshot is kept until the order is finalized); see "Known issues to fix" in
`next-steps.md`.* The whole
updated order is re-priced at current prices (including pizzas the customer did not touch), so a
price moved since the original order shows up in the comparison rather than being hidden. The
comparison is against the order *as it currently stands* (the last saved version); the very first
total is also kept and shown ("first placed at $X"). Nothing is saved until the customer has seen
the comparison and chosen *Save changes*, and the same hold-and-confirm rules as placing apply.

<a id="a20"></a>
### A20. Changing an order never loses history

Each saved change keeps the previous version
(what was ordered, at what prices, for how much). Saving a change that changes nothing saves
nothing.

# Assumptions

Every place the requirements were ambiguous, the call we made, and where it is
implemented. This is the working list; it is folded into the README's *Assumptions*
section. The reasoning behind larger choices lives in `decisions.md`.

## Order lifecycle

**A1. A fifth status, `CANCELLED`, exists.**
The brief names four statuses (Not Started, Started, Ready for Pickup, Delivered) yet
requires that an order can be cancelled. We model cancellation as a distinct terminal
status rather than deleting the order, so the order ID still resolves (a customer who
retries a cancel or checks status gets a clear answer) and there is an audit trail.
Cancel is allowed only from Not Started; see the state machine in `decisions.md` D8.
*Implemented in:* `orders.status` CHECK constraint (`db/schema.sql`), order state machine
(to be built).

**A2. Cancelling is idempotent.**
Cancelling an already-cancelled order returns success with the same result rather than an
error, because mobile clients retry after timeouts and cannot tell whether the first
request landed.

**A4. The kitchen can cancel at any time before delivery; the customer only before the
kitchen starts.**
The brief only says the *customer* may cancel until the kitchen starts. Restaurant staff
are not bound by that: they may need to scrap an order that is already being made (out of
an ingredient, a burnt pizza). So the kitchen may cancel from Not Started, Started or Ready
for Pickup. Nobody can cancel a Delivered order.

**A5. A cancellation can carry an optional reason.**
Free text, up to 200 characters, never required. Not specified in the brief; added so the
kitchen screen can show why an order was cancelled. A retried cancel does not overwrite
the first reason.

**A3. A customer cancelling or editing an order that has moved past Not Started is refused.**
The response is a 409 that includes the order's current status. The service checks the real
status at the moment of the request, so a customer looking at a stale page cannot cancel an
order the kitchen has just started.

**A6. Every status change records who made it and when.**
`customer`, `kitchen` or `system`, with a UTC timestamp, kept in an audit table. Not
required by the brief; it makes cancel-versus-start races explainable after the fact.

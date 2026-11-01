# Assumptions and decisions

The short list. Each ID links to its full entry, with the reasoning and where it is implemented, in
[assumptions-detailed.md](assumptions-detailed.md). The larger design choices are indexed in
[decisions.md](decisions.md).

Two kinds of entry: **assumptions** are how we read a brief that was ambiguous or silent; **decisions beyond
the brief** are rules we chose to add.

## Assumptions (how we read the brief)

| ID | Assumption |
|---|---|
| [A1](assumptions-detailed.md#a1) | A fifth status, `CANCELLED`, exists: the brief lets a customer cancel but names only four statuses. A cancelled order is kept, not deleted. |
| [A2](assumptions-detailed.md#a2) | Cancelling twice is not an error: a retried cancel returns the same result. |
| [A3](assumptions-detailed.md#a3) | A customer cancelling or editing an order past Not Started is refused with a 409 carrying the real current status. |
| [A4](assumptions-detailed.md#a4) | The kitchen can cancel until delivery; only the customer is limited to before the kitchen starts. |
| [A8](assumptions-detailed.md#a8) | Order of operations: subtotal, promos, tax on the discounted amount, then tip. A percentage tip is of the whole bill (discounted subtotal plus tax). |
| [A9](assumptions-detailed.md#a9) | "Over $20" is strict and judged on the subtotal before the discount: exactly $20.00 does not qualify for `SAVE5`. |
| [A10](assumptions-detailed.md#a10) | Promo codes apply in the order entered. A code that is unknown, unmet or not combinable is not applied, with a message; the order is still priced. |
| [A11](assumptions-detailed.md#a11) | Rounding is half-up to the whole cent, at each percentage taken. |
| [A18](assumptions-detailed.md#a18) | A customer can change an order only until the kitchen starts it, the same window as cancelling. |

Out of scope, as the brief says: authentication and security hardening, real payments, a real kitchen
integration.

## Decisions beyond the brief (rules we added)

| ID | Decision |
|---|---|
| [A5](assumptions-detailed.md#a5) | A cancellation can carry an optional reason (up to 200 characters) so the kitchen screen can show why. |
| [A6](assumptions-detailed.md#a6) | The price charged is the price on the menu the customer was shown, within the menu's validity window. |
| [A7](assumptions-detailed.md#a7) | Every status change records who made it (customer, kitchen, system) and when. |
| [A12](assumptions-detailed.md#a12) | Sanity limits: quantity 1 to 100 per line, at most 50 lines, tips at most $500 or 100%. |
| [A13](assumptions-detailed.md#a13) | A topping appears at most once per pizza. |
| [A14](assumptions-detailed.md#a14) | A customer has a fixed time to finish an order: `user_menu_expiry_seconds` (30 minutes by default). |
| [A15](assumptions-detailed.md#a15) | A very large tip (50% or more of the bill, on a bill of $40 or more) is confirmed before the order is placed. |
| [A16](assumptions-detailed.md#a16) | Nothing is charged that the customer has not seen: any difference holds the order until they confirm. |
| [A17](assumptions-detailed.md#a17) | A retry returns the original order, not a second one. |
| [A19](assumptions-detailed.md#a19) | A change is priced on today's menu. **An AI assumption that review says to change**: it should use the menu snapshot from when the order was placed (see [next steps](next-steps.md)). |
| [A20](assumptions-detailed.md#a20) | Changing an order never loses history: every saved version is kept; a no-op change saves nothing. |

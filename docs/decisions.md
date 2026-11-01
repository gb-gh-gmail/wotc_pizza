# Decisions

An index of the design decisions. Each ID links to its full record (what was decided, why, what was
rejected, and what it costs) in [decisions-detailed.md](decisions-detailed.md). Assumptions about the brief are
in [assumptions.md](assumptions.md). All are Decided unless noted.

## Data and money

| ID | Decision | Why, in a line |
|---|---|---|
| [D2](decisions-detailed.md#d2) | SQLite via the built-in `node:sqlite` | No hosted database needed; `better-sqlite3` failed to compile here. |
| [D3](decisions-detailed.md#d3) | Money is integer cents; percentages are integer basis points | Exact arithmetic, no floating point. |
| [D9](decisions-detailed.md#d9) | Rounding is half-up to the whole cent, at each derived amount | Every figure shown is a whole-cent amount that adds up exactly. |
| [D4](decisions-detailed.md#d4) | Menu, prices and promos are data | The brief requires adding a size, topping, category or promo without touching pricing logic. |
| [D5](decisions-detailed.md#d5) | Prices are a separate, effective-dated table linked to the menu item | A price change is an insert; history is kept and old orders are unaffected. |
| [D6](decisions-detailed.md#d6) | Promos: one `exclusive` flag, not a conflicts table | Simpler, and covers the stated rule; cannot express "A conflicts with B but not C". |
| [D7](decisions-detailed.md#d7) | Promo `kind` strategies live in code; parameters live in data | Encoding arbitrary rules in SQL would be a worse language than TypeScript. |
| [D10](decisions-detailed.md#d10) | Tax is an effective-dated `tax_rates` table; orders reference it | A rate change is an insert, and an order can be traced to the rate it paid. |
| [D11](decisions-detailed.md#d11) | Surrogate integer IDs everywhere; `code` is a unique slug | Uniform foreign keys; renaming a code does not cascade. |
| [D12](decisions-detailed.md#d12) | A `menus` table sits above `menu_items` | A seasonal menu is a new row, and old orders stay tied to the menu they used. |
| [D13](decisions-detailed.md#d13) | Menu item type is a lookup table | A new kind of item is an insert, not a schema change. |
| [D14](decisions-detailed.md#d14) | Order lines store the `price_id` they were priced with | So a disputed order can be audited: what was charged, and why. |

## Pricing and the price lock

| ID | Decision | Why, in a line |
|---|---|---|
| [D23](decisions-detailed.md#d23) | Submitted prices are validated against the menu the customer was shown | The customer is never charged something different from what they were told. |
| [D24](decisions-detailed.md#d24) | The pricing engine is one pure function; promos are their own module | One place defines what an order costs, and it is testable with no setup. |
| [D25](decisions-detailed.md#d25) | Menu snapshots, with the expiry in a database setting | Holds the exact prices shown for a fixed time (30 minutes by default). |
| [D26](decisions-detailed.md#d26) | One quote path; promos re-checked on every request; any difference holds the order | The customer confirms any change before it is charged. |

## Orders and the lifecycle

| ID | Decision | Why, in a line |
|---|---|---|
| [D8](decisions-detailed.md#d8) | Order status includes `CANCELLED` | The brief allows cancelling but names only four statuses. |
| [D20](decisions-detailed.md#d20) | Kitchen screen on the order service, with an optional cancellation reason | Staff and customers want to know why an order disappeared. |
| [D21](decisions-detailed.md#d21) | Customer status page and customer cancel | The customer can check on an order and cancel before the kitchen starts. |
| [D28](decisions-detailed.md#d28) | Placing an order re-validates everything, holds on any mismatch, writes all or nothing | What was verified is exactly what is stored. |
| [D29](decisions-detailed.md#d29) | Retries are safe with client-supplied idempotency keys | A dropped connection and a second press places one order. |
| [D30](decisions-detailed.md#d30) | Changing an order: only while Not Started, guarded by status and version, every version kept | A change racing the kitchen has one winner, and nothing is lost. |
| [D32](decisions-detailed.md#d32) | The order description (brief requirement 3) is not implemented | Cut for time, in favour of pricing correctness and the lifecycle. |

## Pages, tooling and process

| ID | Decision | Why, in a line |
|---|---|---|
| [D1](decisions-detailed.md#d1) | Node 24 and TypeScript | One language, so the pages and the service can share the pricing module. |
| [D15](decisions-detailed.md#d15) | Tests: vitest and fast-check | Zero-config TypeScript, table tests and property tests. |
| [D16](decisions-detailed.md#d16) | One shutdown path for every way a process can stop | Cleanup written once cannot drift between handlers. |
| [D17](decisions-detailed.md#d17) | Logging: pino, standard levels, one shared instance | Structured, greppable logs with low overhead. |
| [D18](decisions-detailed.md#d18) | Dev mode: `tsx watch` with a committed `.env.development` | Restart on change with one command. |
| [D19](decisions-detailed.md#d19) | Database bootstrap: schema by version, seed on request | The lightest way to know what is in the file, with no migrations tool yet. |
| [D22](decisions-detailed.md#d22) | Security hardening is deferred until after the build | Cheap to add to a working system, wasteful to design around a moving one. |
| [D27](decisions-detailed.md#d27) | The order page: live totals, a checked-and-confirmed state machine, modal for submitting | The customer always sees figures the service has checked. |
| [D31](decisions-detailed.md#d31) | Pages are re-read on every request in development and never cached | Stale pages had hidden fixes from the author. |

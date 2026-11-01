# API reference

The order service (default `http://localhost:3001`) is a JSON API over HTTP. The customer's browser does not
call it directly: it calls the order builder (`http://localhost:3000`), which relays `/api/*` to the service
with the `/api` prefix removed (so `/api/quote` in the browser is `/quote` here). Every example below goes
straight to the service.

The examples use `curl` and shell variables (bash, or Git Bash on Windows). They were run against a real
service to produce the responses shown. Ids, tokens and times will differ.

- [The flow](#the-flow)
- [Money and conventions](#money-and-conventions)
- [Endpoints](#endpoints): [menu](#get-menu) · [quote](#post-quote) · [place](#post-orders) · [change](#put-ordersid) · [read](#get-ordersid) · [cancel](#post-ordersidcancel) · [kitchen](#kitchen) · [health](#get-health)
- [Errors](#errors)

## The flow

```
GET  /menu                  prices, and a token that locks them for 30 minutes
POST /quote                 what would this order cost? (call it on every change; creates nothing)
POST /orders                place it (needs an Idempotency-Key; held with 409 if anything differs)
GET  /orders/:id            check on it
PUT  /orders/:id            change it, while it is Not Started
POST /orders/:id/cancel     cancel it, while it is Not Started
```

The kitchen has its own endpoints under `/kitchen`.

## Money and conventions

- **Money is whole cents** (`1615` is $16.15). **Rates are basis points** (`650` is 6.5%, `1800` is 18%).
- Times are UTC, ISO 8601, with milliseconds.
- Bodies are JSON (`content-type: application/json`). A field of the wrong type is rejected (400); an unknown
  extra field is ignored.
- **The service never trusts a price you send.** It prices the order itself, from the menu snapshot that
  `menuToken` names. The `claimed` figures are only what your screen is showing, so the service can tell you
  when they differ.
- **Order statuses:** `NOT_STARTED`, `STARTED`, `READY_FOR_PICKUP`, `DELIVERED`, `CANCELLED`.

### An order, as you send it

```json
{
  "lines": [{ "size": "large", "quantity": 1, "toppings": ["pepperoni", "bacon"] }],
  "tip": { "mode": "percent", "bps": 1800 },
  "promoCodes": ["ILOVEPIZZA"]
}
```

| Field | Meaning |
|---|---|
| `lines[].size` | A size code from the menu (`small`, `medium`, `large`) |
| `lines[].quantity` | 1 to 100 |
| `lines[].toppings` | Topping codes; each at most once per pizza |
| `tip` | Optional. `{"mode":"none"}`, `{"mode":"amount","cents":500}` or `{"mode":"percent","bps":1800}`. Never negative; at most $500 or 100% |
| `promoCodes` | Optional. Codes in the order entered; case and spaces are ignored |

At most 50 lines per order.

## Endpoints

### GET /menu

The menu you can order from right now, every price resolved, plus a `menuToken` that locks these prices
until `expiresAt` (30 minutes by default). Every price in a quote or an order is taken from this token.

```
curl -s http://localhost:3001/menu
```

```json
{
  "menu": { "id": 1, "name": "Standard Menu", "effectiveFrom": "2026-01-01T00:00:00.000Z", "effectiveTo": null },
  "sizes": [
    { "code": "small",  "label": "Small",  "priceCents": 500,  "priceId": 1 },
    { "code": "medium", "label": "Medium", "priceCents": 700,  "priceId": 2 },
    { "code": "large",  "label": "Large",  "priceCents": 1200, "priceId": 3 }
  ],
  "toppings": [
    { "code": "pepperoni", "label": "Pepperoni", "category": { "code": "basic", "label": "Basic toppings" },
      "price": { "type": "percentage", "amount": 800 }, "priceId": 4,
      "pricesCents": { "small": 40, "medium": 56, "large": 96 } }
  ],
  "taxRate": { "id": 1, "name": "Sales tax", "rateBps": 650 },
  "pricedAt": "2026-11-01T20:40:03.638Z",
  "menuToken": "4a4d017d-8970-466c-8314-2cccec80e37f",
  "expiresAt": "2026-11-01T21:10:03.638Z",
  "serverTime": "2026-11-01T20:40:03.638Z"
}
```

(`toppings` is shortened here; the real response lists all of them.) `pricesCents` is each topping's price on
each size. `503 no_active_menu` means there is no menu in effect.

### POST /quote

What would this order cost, and does it match what you are showing? It prices the order and creates nothing,
so it is safe to call on every change.

```
TOKEN=4a4d017d-8970-466c-8314-2cccec80e37f

curl -s -X POST http://localhost:3001/quote -H 'content-type: application/json' -d '{
  "menuToken": "'$TOKEN'",
  "order": {
    "lines": [{ "size": "large", "quantity": 1, "toppings": ["pepperoni", "bacon"] }],
    "tip": { "mode": "percent", "bps": 1800 },
    "promoCodes": ["ILOVEPIZZA"]
  },
  "claimed": { "totalCents": 1500, "subtotalCents": 1428 }
}'
```

`claimed` is optional. Without it, `differences` is empty. Here the claimed total is wrong on purpose:

```json
{
  "quote": {
    "menuId": 1,
    "lines": [{
      "size": { "code": "large", "label": "Large", "priceCents": 1200, "priceId": 3 },
      "quantity": 1,
      "toppings": [
        { "code": "pepperoni", "label": "Pepperoni", "priceCents": 96,  "priceId": 4 },
        { "code": "bacon",     "label": "Bacon",     "priceCents": 132, "priceId": 10 }
      ],
      "unitCents": 1428, "lineTotalCents": 1428
    }],
    "subtotalCents": 1428,
    "promos": [{ "code": "ILOVEPIZZA", "applied": true, "discountCents": 143 }],
    "discountCents": 143,
    "taxableCents": 1285,
    "taxRateId": 1, "taxRateBps": 650, "taxCents": 84,
    "tip": { "mode": "percent", "cents": 246, "needsConfirmation": false },
    "totalCents": 1615,
    "withoutPromo": { "taxableCents": 1428, "taxCents": 93, "tipCents": 274, "totalCents": 1795 }
  },
  "matches": false,
  "differences": [
    { "field": "total", "claimed": 1500, "actual": 1615, "message": "Total: you were shown $15.00, but it is $16.15" }
  ],
  "menuToken": "4a4d017d-8970-466c-8314-2cccec80e37f",
  "expiresAt": "2026-11-01T21:10:03.638Z",
  "serverTime": "2026-11-01T20:40:18.376Z"
}
```

How the total is built: subtotal $14.28, minus 10% ($1.43) leaves $12.85; tax at 6.5% on that is $0.84
(rounded half-up); the 18% tip is on the bill after tax ($13.69), $2.46; total $16.15. `withoutPromo` appears
only when a promo applied. A promo that did not apply appears in `promos` with `"applied": false` and a
`message`, and the order is still priced.

| Status | `error` | When |
|---|---|---|
| 422 | `invalid_order` | The order has problems; `issues` lists every one with its `path` |
| 409 | `menu_expired` | The 30 minutes are up; reload the menu |
| 409 | `menu_unknown` | The token is not one the service issued, or its prices are gone |

```json
{ "error": "invalid_order", "message": "Please fix the problems with your order",
  "issues": [
    { "code": "invalid_quantity", "path": "lines[0].quantity", "message": "Quantity must be a whole number from 1 to 100" },
    { "code": "unknown_size", "path": "lines[0].size", "message": "\"huge\" is not a size on the menu" },
    { "code": "duplicate_topping", "path": "lines[0].toppings[1]", "message": "Bacon is already on this pizza" }
  ] }
```

### POST /orders

Place an order. The `Idempotency-Key` header is **required**: 8 to 100 letters, digits, `-` or `_`. Choose one
key per attempt and send the same key if you retry. `claimed` (the total and subtotal your screen shows) is
required.

```
curl -s -i -X POST http://localhost:3001/orders \
  -H 'content-type: application/json' \
  -H 'Idempotency-Key: demo-order-0001' \
  -d '{
    "menuToken": "'$TOKEN'",
    "order": {
      "lines": [{ "size": "large", "quantity": 1, "toppings": ["pepperoni", "bacon"] }],
      "tip": { "mode": "percent", "bps": 1800 },
      "promoCodes": ["ILOVEPIZZA"]
    },
    "claimed": { "totalCents": 1615, "subtotalCents": 1428 }
  }'
```

```
HTTP/1.1 201 Created
location: /orders/01e5b872-780a-4ee5-8ee9-677c6058bb93
```
```json
{
  "order": {
    "id": "01e5b872-780a-4ee5-8ee9-677c6058bb93",
    "status": "NOT_STARTED",
    "createdAt": "2026-11-01T20:40:18.608Z",
    "updatedAt": "2026-11-01T20:40:18.608Z",
    "version": 1,
    "totalCents": 1615,
    "cancellationReason": null,
    "items": [{ "quantity": 1, "size": "Large", "toppings": ["Pepperoni", "Bacon"] }],
    "lines": [{
      "size": { "code": "large", "label": "Large" }, "quantity": 1,
      "toppings": [{ "code": "pepperoni", "label": "Pepperoni" }, { "code": "bacon", "label": "Bacon" }],
      "unitCents": 1428, "lineTotalCents": 1428
    }],
    "pricing": {
      "subtotalCents": 1428, "discountCents": 143, "taxCents": 84,
      "tip": { "mode": "percent", "input": 1800, "cents": 246 },
      "totalCents": 1615,
      "promos": [{ "code": "ILOVEPIZZA", "discountCents": 143 }]
    },
    "revision": 1,
    "original": { "totalCents": 1615 },
    "canCancel": true,
    "canEdit": true
  },
  "trackPath": "/track/01e5b872-780a-4ee5-8ee9-677c6058bb93",
  "replayed": false
}
```

**Retrying is safe.** Send the same request with the same key and you get `200` with `"replayed": true` and
the *original* order; nothing is created twice. This also works after the 30-minute price lock has expired.
The same key with a different order is refused (`422 idempotency_key_reused`).

**The service holds an order rather than charge a figure you have not seen.** If anything differs from what
`claimed` says, or a promo in the order no longer applies, or a very large tip has not been confirmed, nothing
is placed and you get `409 confirmation_required` with the corrected `quote`. Show it to the customer; if they
accept, send the order again with the corrected `claimed` figures.

```json
{
  "error": "confirmation_required",
  "message": "Please review and confirm before we save your order",
  "reasons": ["prices_changed"],
  "quote": { "...": "the full corrected quote, as in POST /quote" },
  "differences": [{ "field": "total", "claimed": 1500, "actual": 1615, "message": "Total: you were shown $15.00, but it is $16.15" }],
  "removedPromos": [],
  "menuToken": "4a4d017d-8970-466c-8314-2cccec80e37f",
  "expiresAt": "2026-11-01T21:10:03.638Z"
}
```

`reasons` is any of `prices_changed`, `promo_removed`, `large_tip`.

**Very large tips.** A tip of 50% or more of the bill, on a bill of $40 or more, is held until confirmed. Here
a $30 tip on a $51.12 bill (`"tip": {"cents": 3000, "needsConfirmation": true}` in the quote) returns
`"reasons": ["large_tip"]`. To confirm it, send the same request again with the tip amount:

```json
"confirmations": { "largeTipCents": 3000 }
```

| Status | `error` | When |
|---|---|---|
| 400 | `idempotency_key_required` | No valid `Idempotency-Key` header |
| 409 | `confirmation_required` | Held, as above |
| 409 | `menu_expired`, `menu_unknown` | As for `/quote` |
| 422 | `invalid_order` | As for `/quote` |
| 422 | `idempotency_key_reused` | The key was used for a different order |

### PUT /orders/:id

Change an order that has not been started. The whole new order is sent (not a patch). It is checked and held
exactly as when placing. `expectedVersion` (the `version` you last saw) is required, and so is an
`Idempotency-Key`.

```
curl -s -X PUT http://localhost:3001/orders/01e5b872-780a-4ee5-8ee9-677c6058bb93 \
  -H 'content-type: application/json' \
  -H 'Idempotency-Key: demo-change-0001' \
  -d '{
    "menuToken": "'$TOKEN'",
    "order": {
      "lines": [
        { "size": "large", "quantity": 1, "toppings": ["pepperoni", "bacon"] },
        { "size": "small", "quantity": 1, "toppings": [] }
      ],
      "tip": { "mode": "percent", "bps": 1800 },
      "promoCodes": ["ILOVEPIZZA"]
    },
    "claimed": { "totalCents": 2181, "subtotalCents": 1928 },
    "expectedVersion": 1
  }'
```

The response has the same `order` shape, now with `"version": 2` and `"totalCents": 2181`, plus
`"previousTotalCents": 1615`, `"unchanged": false` and `"replayed": false`. A change that alters nothing saves
nothing (`"unchanged": true`). Every saved version is kept.

| Status | `error` | When |
|---|---|---|
| 404 | `not_found` | No such order |
| 409 | `order_locked` | The kitchen has started it; `currentStatus` says where it is |
| 409 | `order_cancelled` | It was cancelled |
| 409 | `order_changed` | `expectedVersion` is out of date; the latest `order` is returned |
| 409 | `confirmation_required`, `menu_expired`, `menu_unknown` | As for placing |
| 422 | `invalid_order`, `idempotency_key_reused` | As for placing |

```json
{ "error": "order_locked", "message": "The kitchen has already started your order, so it can no longer be changed.", "currentStatus": "STARTED" }
```

### GET /orders/:id

```
curl -s http://localhost:3001/orders/01e5b872-780a-4ee5-8ee9-677c6058bb93
```

Returns `{ "order": { ... } }` in the shape above, or `404 not_found`. `canCancel` and `canEdit` say whether
the customer can still do either.

### POST /orders/:id/cancel

The customer cancels, while the order is Not Started. Both body fields are optional: `reason` (up to 200
characters) and `expectedStatus` (the status your screen last showed).

```
curl -s -X POST http://localhost:3001/orders/$ID/cancel -H 'content-type: application/json' \
  -d '{ "reason": "Ordered by mistake", "expectedStatus": "NOT_STARTED" }'
```

Returns `200` with the order (`"status": "CANCELLED"`, `"cancellationReason": "Ordered by mistake"`).
Cancelling an already-cancelled order also returns `200` and keeps the first reason.

If the order has moved on, nothing is cancelled and the real status comes back. The service re-reads the status
when the request arrives; it does not rely on what your screen believed:

```json
{ "error": "status_changed", "message": "Order status has changed since you last checked: it is now STARTED, not NOT_STARTED", "currentStatus": "STARTED" }
```

### Kitchen

For the restaurant's screen (`/kitchen`) or any other staff tool. There is no login (out of scope).

| Method and path | What it does |
|---|---|
| `GET /kitchen/orders` | Open orders, newest first. `?include=closed` adds delivered and cancelled orders |
| `POST /kitchen/orders/:id/advance` | Moves to the next status. Body: `{ "expectedStatus": "NOT_STARTED" }` (required) |
| `POST /kitchen/orders/:id/cancel` | Cancels at any status before Delivered. Body: optional `reason`, `expectedStatus` |

```
curl -s -X POST http://localhost:3001/kitchen/orders/$ID/advance \
  -H 'content-type: application/json' -d '{ "expectedStatus": "NOT_STARTED" }'
```

Returns `200` with the order (`"status": "STARTED"`, `"nextStatus": "READY_FOR_PICKUP"`, `"canEdit": false`).
Statuses go Not Started, Started, Ready for Pickup, Delivered, in that order only. If `expectedStatus` is
not the real status, you get `409 status_changed` and nothing happens. The kitchen's view of an order has a
`nextStatus` field that the customer's does not.

```
curl -s -X POST http://localhost:3001/kitchen/orders/$ID/cancel \
  -H 'content-type: application/json' -d '{ "reason": "Out of dough" }'
```

### GET /health

`{"status":"ok","db":"ok"}` when the service and its database are up. The builder has its own
`GET /health` on port 3000.

## Errors

Errors are JSON with an `error` code and a `message`; some add detail (`issues`, `currentStatus`, `quote`).

| Status | Meaning |
|---|---|
| 400 | The request is malformed (a wrong type, bad JSON, or no `Idempotency-Key`) |
| 404 | No such order |
| 409 | Valid request, but the state it depends on has changed: the menu expired, the order moved on, a figure differs and needs confirming |
| 422 | The order itself is wrong (`invalid_order`), or a key was reused |
| 503 | There is no menu in effect, or it is misconfigured |

**Known gaps** (listed in [next steps](next-steps.md) under error handling):
- A 400 for a malformed body comes from the web framework, so it has a different shape
  (`{"statusCode":400,"code":"FST_ERR_VALIDATION","error":"Bad Request","message":"body/menuToken must be string"}`),
  except the missing-key 400, which uses the shape above.
- An unexpected failure (for example, the database being unavailable) also returns an error that is not in this
  shape, and its message may include internal detail.

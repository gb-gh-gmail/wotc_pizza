-- Pizza order service schema (SQLite).
-- Conventions:
--   * Money is INTEGER cents. Percentages are INTEGER basis points (100 bps = 1%).
--   * Menu, prices and promos are DATA, so adding a size, topping, category or
--     promo (or changing a price) is an INSERT, not a change to pricing logic.
--   * Orders snapshot the prices they were charged at, so a later menu or
--     price change never alters an existing order.
-- See docs/decisions.md for the reasoning behind these choices.

PRAGMA foreign_keys = ON;

-- ---------------------------------------------------------------- menu ----

-- A menu is a named, dated set of items. A new seasonal or revised menu is a
-- new row, so old orders keep pointing at the menu they were placed against.
CREATE TABLE menus (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  name          TEXT NOT NULL,
  description   TEXT,
  active        INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  effective_from TEXT NOT NULL,                        -- ISO-8601, inclusive
  effective_to   TEXT,                                 -- NULL = open-ended, exclusive
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  CHECK (effective_to IS NULL OR effective_to > effective_from),
  CHECK (effective_from GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z' AND (effective_to IS NULL OR effective_to GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'))
);

-- Two ACTIVE menus may not have overlapping effective windows, so "which menu
-- applies at time T" has exactly one answer. SQLite CHECK constraints cannot
-- see other rows, so this is enforced with triggers. Windows are half-open
-- [effective_from, effective_to); NULL effective_to means open-ended.
-- Timestamps must be stored in one comparable form (UTC ISO-8601 with 'Z'),
-- because the comparison is lexicographic.
CREATE TRIGGER trg_menus_no_overlap_insert
BEFORE INSERT ON menus
WHEN NEW.active = 1
 AND EXISTS (
   SELECT 1 FROM menus m
   WHERE m.active = 1
     AND m.effective_from < COALESCE(NEW.effective_to, '9999-12-31T23:59:59.999Z')
     AND NEW.effective_from < COALESCE(m.effective_to, '9999-12-31T23:59:59.999Z')
 )
BEGIN
  SELECT RAISE(ABORT, 'active menus must not have overlapping effective windows');
END;

CREATE TRIGGER trg_menus_no_overlap_update
BEFORE UPDATE OF active, effective_from, effective_to ON menus
WHEN NEW.active = 1
 AND EXISTS (
   SELECT 1 FROM menus m
   WHERE m.id <> NEW.id
     AND m.active = 1
     AND m.effective_from < COALESCE(NEW.effective_to, '9999-12-31T23:59:59.999Z')
     AND NEW.effective_from < COALESCE(m.effective_to, '9999-12-31T23:59:59.999Z')
 )
BEGIN
  SELECT RAISE(ABORT, 'active menus must not have overlapping effective windows');
END;

-- Optional grouping for toppings ('basic', 'premium'). Purely descriptive:
-- it carries NO pricing. Price lives on the prices table, per menu item.
CREATE TABLE menu_categories (
  id     INTEGER PRIMARY KEY AUTOINCREMENT,
  code   TEXT NOT NULL UNIQUE,                         -- stable slug for seeds/API: 'basic', 'premium'
  label  TEXT NOT NULL
);

-- What kind of thing a menu item is. Reference data the application relies on
-- ('size' is what a line item's base pizza must be; 'topping' what goes on it),
-- so the rows are seeded here rather than in seed.sql. A new kind of item
-- (e.g. 'side', 'drink') is one INSERT.
CREATE TABLE menu_item_types (
  id     INTEGER PRIMARY KEY AUTOINCREMENT,
  code   TEXT NOT NULL UNIQUE,
  label  TEXT NOT NULL
);

INSERT INTO menu_item_types (code, label) VALUES ('size', 'Size'), ('topping', 'Topping');

-- Everything orderable on a pizza: its size, and each topping.
CREATE TABLE menu_items (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  menu_id      INTEGER NOT NULL REFERENCES menus (id),
  type_id      INTEGER NOT NULL REFERENCES menu_item_types (id),
  code         TEXT NOT NULL,                          -- 'small', 'pepperoni', ... unique within a menu and type
  label        TEXT NOT NULL,
  category_id  INTEGER REFERENCES menu_categories (id),
  active       INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  sort_order   INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  UNIQUE (menu_id, type_id, code)
);

CREATE INDEX idx_menu_items_menu ON menu_items (menu_id);

-- Prices are effective-dated rows, so changing a price = INSERT a new row
-- (and close the old one); history is kept.
--   price_type 'static'     -> amount = cents                (small = 500)
--   price_type 'percentage' -> amount = basis points of the  (basic topping = 800,
--                              base pizza price (size) in      i.e. 8% of the size price)
--                              the same line
CREATE TABLE prices (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  menu_item_id   INTEGER NOT NULL REFERENCES menu_items (id),
  price_type     TEXT NOT NULL CHECK (price_type IN ('static', 'percentage')),
  amount         INTEGER NOT NULL CHECK (amount >= 0),
  effective_from TEXT NOT NULL,                        -- ISO-8601, inclusive
  effective_to   TEXT,                                 -- NULL = open-ended, exclusive
  CHECK (effective_to IS NULL OR effective_to > effective_from),
  CHECK (effective_from GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z' AND (effective_to IS NULL OR effective_to GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'))
);

CREATE INDEX idx_prices_item ON prices (menu_item_id, effective_from);

-- ------------------------------------------------------------------ tax --
-- Effective-dated tax rate, as basis points of the order total after discounts
-- (650 = 6.5%). Orders reference the row they were taxed with. Changing the
-- rate = INSERT a new row (and close the old one); never edit a used row.

CREATE TABLE tax_rates (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  name            TEXT NOT NULL,                       -- 'Sales tax'
  rate_bps        INTEGER NOT NULL CHECK (rate_bps >= 0),
  effective_from  TEXT NOT NULL,                       -- ISO-8601 UTC, inclusive
  effective_to    TEXT,                                -- NULL = open-ended, exclusive
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  CHECK (effective_to IS NULL OR effective_to > effective_from),
  CHECK (effective_from GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z' AND (effective_to IS NULL OR effective_to GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'))
);

-- Tax windows may not overlap, so "the rate at time T" has exactly one answer.
-- Same half-open [from, to) rules and UTC-'Z' timestamp requirement as menus.
CREATE TRIGGER trg_tax_rates_no_overlap_insert
BEFORE INSERT ON tax_rates
WHEN EXISTS (
  SELECT 1 FROM tax_rates t
  WHERE t.effective_from < COALESCE(NEW.effective_to, '9999-12-31T23:59:59.999Z')
    AND NEW.effective_from < COALESCE(t.effective_to, '9999-12-31T23:59:59.999Z')
)
BEGIN
  SELECT RAISE(ABORT, 'tax rates must not have overlapping effective windows');
END;

CREATE TRIGGER trg_tax_rates_no_overlap_update
BEFORE UPDATE OF effective_from, effective_to ON tax_rates
WHEN EXISTS (
  SELECT 1 FROM tax_rates t
  WHERE t.id <> NEW.id
    AND t.effective_from < COALESCE(NEW.effective_to, '9999-12-31T23:59:59.999Z')
    AND NEW.effective_from < COALESCE(t.effective_to, '9999-12-31T23:59:59.999Z')
)
BEGIN
  SELECT RAISE(ABORT, 'tax rates must not have overlapping effective windows');
END;

-- ---------------------------------------------------------------- promos --
-- A promo is a `kind` (a small registered strategy in code, e.g.
-- 'percent_off' or 'flat_off') plus data parameters. A new promo that reuses
-- an existing kind is an INSERT only; a new rule shape is one new strategy
-- registered by name, with the core pricing function untouched.
--
-- `exclusive` (default 1): when set, the promo cannot be combined with any
-- other promo. This replaces a pairwise conflicts table.

CREATE TABLE promos (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  code                TEXT NOT NULL UNIQUE,            -- what the customer types; stored upper-case: 'ILOVEPIZZA', 'SAVE5'
  kind               TEXT NOT NULL,                   -- 'percent_off' | 'flat_off' | ...
  percent_bps         INTEGER CHECK (percent_bps BETWEEN 0 AND 10000),
  amount_cents        INTEGER CHECK (amount_cents >= 0),
  min_subtotal_cents  INTEGER CHECK (min_subtotal_cents >= 0),  -- pre-tax subtotal must be STRICTLY over this
  exclusive           INTEGER NOT NULL DEFAULT 1 CHECK (exclusive IN (0, 1)),
  active              INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  starts_at           TEXT,                            -- optional ISO-8601 validity window
  ends_at             TEXT,
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL,
  -- Compared as text, so only the canonical form YYYY-MM-DDTHH:MM:SS.sssZ is accepted.
  CHECK (starts_at IS NULL OR starts_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'),
  CHECK (ends_at IS NULL OR ends_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z')
);

-- -------------------------------------------------------------- settings --
-- Operational settings the service reads at run time, so they can be changed
-- without a deploy. Rows the application depends on are seeded here, not in
-- seed.sql, so a fresh database always has them.

CREATE TABLE settings (
  key          TEXT PRIMARY KEY,
  value        INTEGER NOT NULL,
  description  TEXT NOT NULL
);

-- How long a customer has to complete an order after loading the menu. Prices are
-- locked to the menu snapshot for this long (docs/decisions.md D23); the order
-- builder shows the deadline and warns when it passes.
INSERT INTO settings (key, value, description) VALUES
  ('user_menu_expiry_seconds', 1800, 'Seconds a customer has to submit an order after loading the menu');

-- ------------------------------------------------------- menu snapshots --
-- What a customer was shown when they loaded the menu: every resolved price and
-- the tax rate, frozen as JSON. An order is priced and verified against the
-- snapshot named by its token, NOT against today's prices, so a price change
-- made while the customer is building their order never changes what they are
-- charged (docs/decisions.md D23). Snapshots are valid until expires_at
-- (settings: user_menu_expiry_seconds); one still referenced by an order is kept.

CREATE TABLE menu_snapshots (
  token         TEXT PRIMARY KEY,                      -- GUID handed to the client
  menu_id       INTEGER NOT NULL REFERENCES menus (id),
  content_hash  TEXT NOT NULL,                         -- sha256 of the priced content, so identical menus can share a snapshot
  data          TEXT NOT NULL CHECK (json_valid(data)),
  created_at    TEXT NOT NULL,
  expires_at    TEXT NOT NULL,
  CHECK (created_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'),
  CHECK (expires_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'),
  CHECK (expires_at > created_at)
);

CREATE INDEX idx_menu_snapshots_reuse ON menu_snapshots (content_hash, created_at);

-- ---------------------------------------------------------------- orders --

CREATE TABLE orders (
  id              TEXT PRIMARY KEY,                    -- server-generated (UUID/ULID)
  status          TEXT NOT NULL DEFAULT 'NOT_STARTED'
                  CHECK (status IN ('NOT_STARTED', 'STARTED', 'READY_FOR_PICKUP', 'DELIVERED', 'CANCELLED')),
  -- Optimistic-concurrency counter: every state change or update bumps it.
  version         INTEGER NOT NULL DEFAULT 1,

  menu_id         INTEGER NOT NULL REFERENCES menus (id),  -- the menu this order was priced against
  menu_snapshot_token TEXT NOT NULL REFERENCES menu_snapshots (token),  -- exactly what the customer was shown

  -- Optional free-text why, set only when status is CANCELLED (see docs/decisions.md D8, D20).
  cancellation_reason TEXT
                  CHECK (cancellation_reason IS NULL OR (status = 'CANCELLED' AND length(cancellation_reason) <= 200)),

  tip_mode       TEXT NOT NULL DEFAULT 'none' CHECK (tip_mode IN ('none', 'amount', 'percent')),
  tip_input       INTEGER NOT NULL DEFAULT 0 CHECK (tip_input >= 0),  -- cents for 'amount', bps for 'percent'

  -- Priced result, snapshotted when the order is submitted/updated.
  -- This is the authoritative charge.
  subtotal_cents  INTEGER NOT NULL CHECK (subtotal_cents >= 0),
  discount_cents  INTEGER NOT NULL DEFAULT 0 CHECK (discount_cents >= 0),
  tax_rate_id     INTEGER NOT NULL REFERENCES tax_rates (id),  -- the rate this order was taxed with
  tax_cents      INTEGER NOT NULL CHECK (tax_cents >= 0),
  tip_cents       INTEGER NOT NULL DEFAULT 0 CHECK (tip_cents >= 0),
  total_cents     INTEGER NOT NULL CHECK (total_cents >= 0),

  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);

CREATE INDEX idx_orders_status ON orders (status);

-- Promos entered on an order. More than one row is allowed so that an
-- attempted combination can be validated (and rejected) by the exclusive rule.
CREATE TABLE order_promos (
  order_id        TEXT NOT NULL REFERENCES orders (id) ON DELETE CASCADE,
  promo_id        INTEGER NOT NULL REFERENCES promos (id),
  discount_cents  INTEGER NOT NULL CHECK (discount_cents >= 0),  -- snapshot of what this promo took off
  PRIMARY KEY (order_id, promo_id)
);

CREATE TABLE order_items (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id           TEXT NOT NULL REFERENCES orders (id) ON DELETE CASCADE,
  position           INTEGER NOT NULL,                 -- display order within the order
  size_item_id       INTEGER NOT NULL REFERENCES menu_items (id),  -- must be type 'size' (enforced in app)
  price_id           INTEGER NOT NULL REFERENCES prices (id),      -- the exact price row applied to the size
  quantity           INTEGER NOT NULL CHECK (quantity BETWEEN 1 AND 100),
  base_price_cents   INTEGER NOT NULL,                 -- snapshot: size price when ordered
  unit_price_cents   INTEGER NOT NULL,                 -- snapshot: base + toppings, one pizza
  line_total_cents   INTEGER NOT NULL,                 -- unit_price_cents * quantity
  UNIQUE (order_id, position)
);

CREATE TABLE order_item_toppings (
  order_item_id    INTEGER NOT NULL REFERENCES order_items (id) ON DELETE CASCADE,
  topping_item_id  INTEGER NOT NULL REFERENCES menu_items (id),  -- must be type 'topping' (enforced in app)
  price_id         INTEGER NOT NULL REFERENCES prices (id),      -- the exact price row applied to the topping
  price_cents      INTEGER NOT NULL,                   -- snapshot: per-pizza topping price (price_id resolved against the size)
  PRIMARY KEY (order_item_id, topping_item_id)         -- a topping appears at most once per pizza
);

-- Append-only audit of status changes; also shows who won a cancel-vs-start race.
CREATE TABLE order_status_events (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id     TEXT NOT NULL REFERENCES orders (id) ON DELETE CASCADE,
  from_status  TEXT,
  to_status    TEXT NOT NULL,
  actor        TEXT NOT NULL CHECK (actor IN ('customer', 'kitchen', 'system')),
  at           TEXT NOT NULL
);

CREATE INDEX idx_status_events_order ON order_status_events (order_id, id);

-- Every version of an order. Revision 1 is exactly what the customer first placed; each accepted
-- change (docs/decisions.md D30) adds one. The order rows above always hold the CURRENT version,
-- so this is what keeps "what did they originally order, and for how much?" answerable, and it
-- is the audit trail for changes. `contents` is the priced order as JSON (lines, toppings, promos, tip).
CREATE TABLE order_revisions (
  order_id             TEXT NOT NULL REFERENCES orders (id) ON DELETE CASCADE,
  revision             INTEGER NOT NULL CHECK (revision >= 1),
  menu_snapshot_token  TEXT NOT NULL REFERENCES menu_snapshots (token),  -- the prices this version was charged at
  subtotal_cents       INTEGER NOT NULL CHECK (subtotal_cents >= 0),
  discount_cents       INTEGER NOT NULL CHECK (discount_cents >= 0),
  tax_cents            INTEGER NOT NULL CHECK (tax_cents >= 0),
  tip_cents            INTEGER NOT NULL CHECK (tip_cents >= 0),
  total_cents          INTEGER NOT NULL CHECK (total_cents >= 0),
  contents             TEXT NOT NULL CHECK (json_valid(contents)),
  created_at           TEXT NOT NULL,
  PRIMARY KEY (order_id, revision)
);

-- ----------------------------------------------------------- idempotency --
-- Makes POST /orders safe to retry. The key is chosen by the client. The
-- request hash detects a key reused with a different body (answered with 422
-- rather than silently returning the wrong order).

CREATE TABLE idempotency_keys (
  key           TEXT PRIMARY KEY,
  request_hash  TEXT NOT NULL,
  order_id      TEXT NOT NULL REFERENCES orders (id) ON DELETE CASCADE,
  created_at    TEXT NOT NULL
);

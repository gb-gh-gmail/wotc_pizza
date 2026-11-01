-- Seed data: the restaurant's menu and promos from the brief.
-- Run after schema.sql. Idempotent only on a fresh database.

-- ------------------------------------------------------------------ tax ----

INSERT INTO tax_rates (name, rate_bps, effective_from, effective_to, created_at, updated_at)
VALUES ('Sales tax', 650, '2026-01-01T00:00:00Z', NULL, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z');

-- ------------------------------------------------------------ the menu ----

INSERT INTO menus (name, description, active, effective_from, effective_to, created_at, updated_at)
VALUES ('Standard Menu', 'Launch menu', 1, '2026-01-01T00:00:00Z', NULL,
        '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z');

INSERT INTO menu_categories (code, label) VALUES
  ('basic',   'Basic toppings'),
  ('premium', 'Premium toppings');

-- ----------------------------------------------------------- menu items ----
-- Items are looked up by menu name and type code so ids are never hard-coded.

INSERT INTO menu_items (menu_id, type_id, code, label, category_id, sort_order, created_at, updated_at)
SELECT m.id, t.id, v.code, v.label, c.id, v.sort_order, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z'
FROM (
  -- type,     code,                 label,                 category, sort
  SELECT 'size'    AS type, 'small'              AS code, 'Small'              AS label, NULL      AS category, 1  AS sort_order UNION ALL
  SELECT 'size',            'medium',                      'Medium',                     NULL,                2  UNION ALL
  SELECT 'size',            'large',                       'Large',                      NULL,                3  UNION ALL
  SELECT 'topping',         'pepperoni',                   'Pepperoni',                  'basic',             10 UNION ALL
  SELECT 'topping',         'sausage',                     'Sausage',                    'basic',             11 UNION ALL
  SELECT 'topping',         'extra_cheese',                'Extra cheese',               'basic',             12 UNION ALL
  SELECT 'topping',         'onions',                      'Onions',                     'basic',             13 UNION ALL
  SELECT 'topping',         'black_olives',                'Black olives',               'basic',             14 UNION ALL
  SELECT 'topping',         'green_peppers',               'Green peppers',              'basic',             15 UNION ALL
  SELECT 'topping',         'bacon',                       'Bacon',                      'premium',           20 UNION ALL
  SELECT 'topping',         'chicken',                     'Chicken',                    'premium',           21 UNION ALL
  SELECT 'topping',         'garlic',                      'Garlic',                     'premium',           22 UNION ALL
  SELECT 'topping',         'artichoke_hearts',            'Artichoke hearts',           'premium',           23 UNION ALL
  SELECT 'topping',         'sun_dried_tomatoes',          'Sun-dried tomatoes',         'premium',           24 UNION ALL
  SELECT 'topping',         'pineapple',                   'Pineapple',                  'premium',           25
) v
JOIN menus m            ON m.name = 'Standard Menu'
JOIN menu_item_types t  ON t.code = v.type
LEFT JOIN menu_categories c ON c.code = v.category;

-- --------------------------------------------------------------- prices ----
-- Sizes: static cents. Toppings: percentage (basis points) of the size price.

INSERT INTO prices (menu_item_id, price_type, amount, effective_from, effective_to)
SELECT i.id, 'static', v.cents, '2026-01-01T00:00:00Z', NULL
FROM (
  SELECT 'small' AS code, 500 AS cents UNION ALL
  SELECT 'medium', 700 UNION ALL
  SELECT 'large', 1200
) v
JOIN menu_items i      ON i.code = v.code
JOIN menu_item_types t ON t.id = i.type_id AND t.code = 'size';

INSERT INTO prices (menu_item_id, price_type, amount, effective_from, effective_to)
SELECT i.id, 'percentage',
       CASE c.code WHEN 'basic' THEN 800 WHEN 'premium' THEN 1100 END,  -- 8% / 11%
       '2026-01-01T00:00:00Z', NULL
FROM menu_items i
JOIN menu_item_types t  ON t.id = i.type_id AND t.code = 'topping'
JOIN menu_categories c  ON c.id = i.category_id;

-- --------------------------------------------------------------- promos ----
-- Both are exclusive (the default), which gives "SAVE5 cannot be combined with
-- ILOVEPIZZA" without a pairwise conflict table.

INSERT INTO promos (code, kind, percent_bps, amount_cents, min_subtotal_cents, exclusive, active, created_at, updated_at)
VALUES
  ('ILOVEPIZZA', 'percent_off', 1000, NULL, NULL, 1, 1, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z'),
  ('SAVE5',      'flat_off',    NULL, 500,  2000, 1, 1, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z');

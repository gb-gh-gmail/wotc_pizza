/**
 * Stage 1 of pricing: validate the order's lines and price them from the menu.
 * Knows nothing about promos, tax or tip.
 */
import type { MenuSnapshot } from './menu.js';
import type { Cents } from './money.js';
import { LIMITS, type Issue, type OrderLineInput, type PricedLine } from './order.js';

export type LinesResult =
  | { ok: true; lines: PricedLine[]; subtotalCents: Cents }
  | { ok: false; issues: Issue[] };

/**
 * Price every line against the menu. Reports every problem across all lines at
 * once (not just the first), each with where it is. The input comes from an API,
 * so any shape is tolerated: bad input produces issues, never an exception.
 */
export function priceLines(inputLines: unknown, menu: MenuSnapshot): LinesResult {
  const issues: Issue[] = [];
  const sizes = new Map(menu.sizes.map((s) => [s.code, s]));
  const toppings = new Map(menu.toppings.map((t) => [t.code, t]));

  const input = (Array.isArray(inputLines) ? inputLines : []) as (OrderLineInput | null | undefined)[];
  if (input.length === 0) issues.push({ code: 'empty_order', path: 'lines', message: 'Add at least one pizza to your order' });
  if (input.length > LIMITS.maxLines) {
    issues.push({ code: 'too_many_lines', path: 'lines', message: `An order can have at most ${LIMITS.maxLines} pizzas` });
  }

  const lines: PricedLine[] = [];
  input.forEach((line, i) => {
    const at = `lines[${i}]`;
    let ok = true;

    const quantity = line?.quantity;
    if (typeof quantity !== 'number' || !Number.isSafeInteger(quantity) || quantity < 1 || quantity > LIMITS.maxQuantity) {
      issues.push({ code: 'invalid_quantity', path: `${at}.quantity`, message: `Quantity must be a whole number from 1 to ${LIMITS.maxQuantity}` });
      ok = false;
    }

    const size = typeof line?.size === 'string' ? sizes.get(line.size) : undefined;
    if (!size) {
      issues.push({ code: 'unknown_size', path: `${at}.size`, message: `"${String(line?.size)}" is not a size on the menu` });
      ok = false;
    }

    const seen = new Set<string>();
    const priced: PricedLine['toppings'] = [];
    (Array.isArray(line?.toppings) ? line.toppings : []).forEach((code, j) => {
      const topping = typeof code === 'string' ? toppings.get(code) : undefined;
      if (!topping) {
        issues.push({ code: 'unknown_topping', path: `${at}.toppings[${j}]`, message: `"${String(code)}" is not a topping on the menu` });
        ok = false;
      } else if (seen.has(topping.code)) {
        issues.push({ code: 'duplicate_topping', path: `${at}.toppings[${j}]`, message: `${topping.label} is already on this pizza` });
        ok = false;
      } else {
        seen.add(topping.code);
        if (size) {
          priced.push({ code: topping.code, label: topping.label, priceCents: topping.pricesCents[size.code]!, priceId: topping.priceId });
        }
      }
    });

    if (ok && size) {
      const unitCents = size.priceCents + priced.reduce((sum, t) => sum + t.priceCents, 0);
      lines.push({
        size: { code: size.code, label: size.label, priceCents: size.priceCents, priceId: size.priceId },
        quantity: quantity as number,
        toppings: priced,
        unitCents,
        lineTotalCents: unitCents * (quantity as number),
      });
    }
  });

  if (issues.length > 0) return { ok: false, issues };
  return { ok: true, lines, subtotalCents: lines.reduce((sum, l) => sum + l.lineTotalCents, 0) };
}

/**
 * The shape of a priced menu, as the pricing engine consumes it and as the order
 * service stores it in a menu snapshot (docs/decisions-detailed.md D23). Plain data: no
 * database, no I/O, so it can be shared with the browser.
 */
import { bpsOf, type Cents } from './money.js';

/** How an item is priced: a flat amount in cents, or basis points of the base pizza price. */
export interface PriceRule {
  type: 'static' | 'percentage';
  amount: number;
}

/** What one topping costs on a pizza whose base price is `sizePriceCents`. */
export function toppingPriceCents(rule: PriceRule, sizePriceCents: Cents): Cents {
  return rule.type === 'static' ? rule.amount : bpsOf(sizePriceCents, rule.amount);
}

export interface MenuSize {
  code: string;
  label: string;
  priceCents: Cents;
  /** The `prices` row this came from, recorded on order lines for audit. */
  priceId: number;
}

export interface MenuTopping {
  code: string;
  label: string;
  category: { code: string; label: string } | null;
  /** The rule as stored. */
  price: PriceRule;
  priceId: number;
  /** The rule resolved for each size code, in cents. */
  pricesCents: Record<string, Cents>;
}

export interface MenuSnapshot {
  menu: { id: number; name: string; description: string | null; effectiveFrom: string; effectiveTo: string | null };
  sizes: MenuSize[];
  toppings: MenuTopping[];
  taxRate: { id: number; name: string; rateBps: number };
  /** The instant these prices were resolved for (canonical UTC timestamp). */
  pricedAt: string;
}

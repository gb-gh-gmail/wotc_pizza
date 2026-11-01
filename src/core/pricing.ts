/**
 * The pricing engine: one pure function that turns an order and a menu snapshot
 * into a complete, exact breakdown. It is the single source of truth for what an
 * order costs; the order service uses it to charge, and the order builder uses the
 * same code to show the running total, so the two cannot disagree.
 *
 * It only conducts three stages, each in its own module and tested on its own:
 *
 *   1. lines.ts   validate the lines and price them            -> subtotal
 *   2. promos.ts  apply promo codes to the subtotal            -> discount
 *   3. totals.ts  tax on the discounted amount, tip, total, and a final consistency check
 *
 * No I/O, no clock, no database. All amounts are integer cents (money.ts); the only
 * rounding is half-up, applied where each percentage is taken. Order of operations
 * and its rationale: docs/assumptions.md (A8).
 */
import type { MenuSnapshot } from './menu.js';
import { priceLines } from './lines.js';
import { type Cents } from './money.js';
import type { Issue, OrderInput, PricedLine, TipInput } from './order.js';
import { applyPromos, DEFAULT_PROMO_KINDS, type PromoDef, type PromoKind, type PromoOutcome } from './promos.js';
import { checkTip, computeTotals, inconsistencies, needsTipConfirmation, type Totals } from './totals.js';

// One place to import everything the engine speaks, so callers need not know the stage modules.
export { LIMITS } from './order.js';
export type { Issue, IssueCode, OrderInput, OrderLineInput, PricedLine, TipInput } from './order.js';
export { DEFAULT_PROMO_KINDS } from './promos.js';
export type { PromoDef, PromoKind, PromoOrder, PromoOutcome } from './promos.js';

export interface Breakdown {
  menuId: number;
  lines: PricedLine[];
  subtotalCents: Cents;
  promos: PromoOutcome[];
  discountCents: Cents;
  /** subtotal - discount: the amount tax is charged on. */
  taxableCents: Cents;
  taxRateId: number;
  taxRateBps: number;
  taxCents: Cents;
  tip: {
    mode: TipInput['mode'];
    cents: Cents;
    /** The tip is half the bill or more (on a bill of $40 or more): the customer must confirm it. */
    needsConfirmation: boolean;
  };
  totalCents: Cents;
  /**
   * What tax, tip and total would be with NO promo, so the customer can see what each
   * saved them. Only present when a promo actually applied: with no promo it would
   * just repeat the figures above, so it is not computed.
   */
  withoutPromo: Totals | null;
}

export type PriceResult = { ok: true; breakdown: Breakdown } | { ok: false; issues: Issue[] };

export function priceOrder(
  order: OrderInput,
  menu: MenuSnapshot,
  promos: readonly PromoDef[] = [],
  kinds: Readonly<Record<string, PromoKind>> = DEFAULT_PROMO_KINDS,
): PriceResult {
  // The order arrives from an API: tolerate any shape and report problems instead of throwing.
  const tip: TipInput = order?.tip ?? { mode: 'none' };

  // ---- 1. lines (and the tip, so every problem with the order is reported together)
  const priced = priceLines(order?.lines, menu);
  const tipIssue = checkTip(tip);
  if (!priced.ok || tipIssue) {
    return { ok: false, issues: [...(priced.ok ? [] : priced.issues), ...(tipIssue ? [tipIssue] : [])] };
  }

  // ---- 2. promos, on the subtotal
  const codes = Array.isArray(order.promoCodes) ? order.promoCodes : [];
  const promo = applyPromos(codes, promos, { subtotalCents: priced.subtotalCents, lines: priced.lines }, kinds);

  // ---- 3. tax, tip and total
  const totals = computeTotals({
    subtotalCents: priced.subtotalCents,
    discountCents: promo.discountCents,
    taxRateBps: menu.taxRate.rateBps,
    tip,
  });

  // The extra work, only when a promo applied: the same totals stage with a discount of zero.
  const withoutPromo = promo.outcomes.some((o) => o.applied)
    ? computeTotals({ subtotalCents: priced.subtotalCents, discountCents: 0, taxRateBps: menu.taxRate.rateBps, tip })
    : null;

  const breakdown: Breakdown = {
    menuId: menu.menu.id,
    lines: priced.lines,
    subtotalCents: priced.subtotalCents,
    promos: promo.outcomes,
    discountCents: promo.discountCents,
    taxableCents: totals.taxableCents,
    taxRateId: menu.taxRate.id,
    taxRateBps: menu.taxRate.rateBps,
    taxCents: totals.taxCents,
    tip: {
      mode: tip.mode,
      cents: totals.tipCents,
      needsConfirmation: needsTipConfirmation(totals.taxableCents + totals.taxCents, totals.tipCents),
    },
    totalCents: totals.totalCents,
    withoutPromo,
  };

  // The last check: never hand out an amount that does not add up. This can only fail through a bug.
  const problems = inconsistencies(breakdown);
  if (problems.length > 0) throw new Error(`pricing produced an inconsistent breakdown: ${problems.join('; ')}`);

  return { ok: true, breakdown };
}

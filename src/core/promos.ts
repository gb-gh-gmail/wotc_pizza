/**
 * Promo codes: which of the codes a customer entered apply to an order, and what
 * each takes off. Pure and independent of the rest of pricing: it is handed the
 * pre-tax subtotal and the available promos, and returns discounts. The pricing
 * engine calls it once base pricing is done, then works out tax and totals from
 * the discounted amount (pricing.ts).
 *
 * Promo behaviour is data (a database row) plus a small registered strategy per
 * `kind`. A new promo of an existing kind is an INSERT; a new kind is one entry
 * in the kinds table. Neither touches the pricing engine.
 */
import { bpsOf, formatCents, type Cents } from './money.js';
import type { PricedLine } from './order.js';

/** A promo as stored in the database (see `promos` in db/schema.sql). */
export interface PromoDef {
  code: string;
  /** Which strategy computes the discount: 'percent_off', 'flat_off', ... */
  kind: string;
  percentBps: number | null;
  amountCents: number | null;
  /** The pre-tax subtotal must be strictly OVER this for the promo to apply. */
  minSubtotalCents: number | null;
  /** When true the promo cannot be combined with any other promo. */
  exclusive: boolean;
}

/**
 * The order as a promo sees it, after base pricing: the subtotal and every priced line
 * (size, toppings, unit and line prices). Whole-order promos use the subtotal; a
 * line-specific promo ("$2 off each large pizza") looks at the lines.
 */
export interface PromoOrder {
  subtotalCents: Cents;
  lines: PricedLine[];
}

/**
 * A strategy returns the discount in cents, or a reason it cannot apply. It is handed a
 * COPY of the order, so it can read freely and can never alter the order being priced.
 */
export type PromoKind = (promo: PromoDef, order: PromoOrder) => { discountCents: Cents } | { reject: string };

export const DEFAULT_PROMO_KINDS: Readonly<Record<string, PromoKind>> = {
  percent_off: (promo, order) =>
    promo.percentBps === null
      ? { reject: 'This promo is not set up correctly' }
      : { discountCents: bpsOf(order.subtotalCents, promo.percentBps) },
  flat_off: (promo, order) =>
    promo.amountCents === null
      ? { reject: 'This promo is not set up correctly' }
      : { discountCents: Math.min(promo.amountCents, order.subtotalCents) }, // never discount below $0
};

export interface PromoOutcome {
  code: string;
  applied: boolean;
  discountCents: Cents;
  /** Why it did not apply (shown to the customer). */
  message?: string;
}

export interface PromoResult {
  /** One entry per distinct code entered, in the order entered. */
  outcomes: PromoOutcome[];
  /** The total taken off the subtotal; never more than the subtotal. */
  discountCents: Cents;
}

/**
 * Apply promo codes, in the order entered, to a pre-tax subtotal. A code that is
 * unknown, whose conditions are not met, or that cannot be combined with one
 * already applied is NOT applied and carries a message; it never causes an error,
 * so the order can still be priced and the customer told why.
 *
 * Case, surrounding spaces, blank entries and repeats are ignored.
 */
export function applyPromos(
  codes: readonly unknown[],
  promos: readonly PromoDef[],
  order: PromoOrder,
  kinds: Readonly<Record<string, PromoKind>> = DEFAULT_PROMO_KINDS,
): PromoResult {
  const subtotalCents = order.subtotalCents;
  const byCode = new Map(promos.map((p) => [p.code.toUpperCase(), p]));
  const outcomes: PromoOutcome[] = [];
  const applied: PromoDef[] = [];
  let discount = 0;

  const seen = new Set<string>();
  for (const raw of codes) {
    const code = String(raw).trim().toUpperCase();
    if (code === '' || seen.has(code)) continue;
    seen.add(code);

    const reject = (message: string): void => void outcomes.push({ code, applied: false, discountCents: 0, message });

    const promo = byCode.get(code);
    if (!promo) {
      reject(`"${code}" is not a valid promo code`);
      continue;
    }
    // "Exclusive" means it can't share an order with any other promo, whichever was entered first.
    const clash = applied.find((a) => a.exclusive || promo.exclusive);
    if (clash) {
      reject(`${promo.code} cannot be combined with ${clash.code}`);
      continue;
    }
    if (promo.minSubtotalCents !== null && subtotalCents <= promo.minSubtotalCents) {
      reject(`${promo.code} needs an order over ${formatCents(promo.minSubtotalCents)} before tax`);
      continue;
    }
    const kind = kinds[promo.kind];
    if (!kind) {
      reject('This promo is not available right now');
      continue;
    }
    // A fresh copy per strategy: it cannot change the real order, nor affect the next promo.
    const result = kind(promo, structuredClone(order));
    if ('reject' in result) {
      reject(result.reject);
      continue;
    }

    applied.push(promo);
    discount += result.discountCents;
    outcomes.push({ code, applied: true, discountCents: result.discountCents });
  }

  // However promos stack, the order never goes below $0.
  return { outcomes, discountCents: Math.min(discount, subtotalCents) };
}

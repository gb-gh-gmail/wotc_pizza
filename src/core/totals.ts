/**
 * Stage 3 of pricing: from the subtotal and the discount, work out tax, tip and the
 * total, then check the whole breakdown adds up. Knows nothing about menus or promos.
 *
 *   taxable = subtotal - discount
 *   tax     = tax rate * taxable                       (rounded half-up, money.ts)
 *   tip     = flat amount, or a percentage of (taxable + tax)
 *   total   = taxable + tax + tip
 */
import { bpsOf, formatCents, type Cents } from './money.js';
import { LIMITS, TIP_CONFIRMATION, type Issue, type PricedLine, type TipInput } from './order.js';

export interface Totals {
  taxableCents: Cents;
  taxCents: Cents;
  tipCents: Cents;
  totalCents: Cents;
}

/** Is the tip something we can charge? Returns the problem, or null. */
export function checkTip(tip: unknown): Issue | null {
  const bad = (message: string): Issue => ({ code: 'invalid_tip', path: 'tip', message });
  const t = tip as TipInput | null | undefined;
  switch (t?.mode) {
    case 'none':
      return null;
    case 'amount':
      if (typeof t.cents !== 'number' || !Number.isSafeInteger(t.cents) || t.cents < 0) return bad('Tip must be a dollar amount of $0.00 or more');
      if (t.cents > LIMITS.maxTipCents) return bad(`Tip cannot be more than ${formatCents(LIMITS.maxTipCents)}`);
      return null;
    case 'percent':
      if (typeof t.bps !== 'number' || !Number.isSafeInteger(t.bps) || t.bps < 0) return bad('Tip must be a percentage of 0% or more');
      if (t.bps > LIMITS.maxTipBps) return bad(`Tip cannot be more than ${LIMITS.maxTipBps / 100}%`);
      return null;
    default:
      return bad('Choose no tip, a dollar amount, or a percentage');
  }
}

/** Tax, tip and total. The tip must already have passed `checkTip`. */
export function computeTotals(input: {
  subtotalCents: Cents;
  discountCents: Cents;
  taxRateBps: number;
  tip: TipInput;
}): Totals {
  const { subtotalCents, discountCents, taxRateBps, tip } = input;
  const taxableCents = subtotalCents - discountCents;
  const taxCents = bpsOf(taxableCents, taxRateBps);
  const billCents = taxableCents + taxCents;
  const tipCents = tip.mode === 'amount' ? tip.cents : tip.mode === 'percent' ? bpsOf(billCents, tip.bps) : 0;
  return { taxableCents, taxCents, tipCents, totalCents: billCents + tipCents };
}

/**
 * Is this tip big enough that the customer should confirm it? True when the tip is at least
 * half the bill (discounted subtotal plus tax) and the bill is $40.00 or more. A tip of
 * nothing never needs confirming. Whole-number arithmetic, so there is no rounding at the edge:
 * tip / bill >= minShare  <=>  tip * 10000 >= bill * minShareBps.
 */
export function needsTipConfirmation(billCents: Cents, tipCents: Cents): boolean {
  if (tipCents <= 0 || billCents < TIP_CONFIRMATION.exemptBillBelowCents) return false;
  return tipCents * 10_000 >= billCents * TIP_CONFIRMATION.minShareBps;
}

/** Everything the consistency check looks at. */
export interface Checkable {
  lines: Pick<PricedLine, 'unitCents' | 'quantity' | 'lineTotalCents'>[];
  subtotalCents: Cents;
  discountCents: Cents;
  taxableCents: Cents;
  taxCents: Cents;
  tip: { cents: Cents };
  totalCents: Cents;
}

/**
 * The last check before an amount is allowed out: the breakdown must add up and be
 * made of whole, non-negative cents. Returns what is wrong (empty when it is fine).
 * A non-empty result means a bug in a pricing stage, not bad input from a customer.
 */
export function inconsistencies(b: Checkable): string[] {
  const problems: string[] = [];
  const amounts: [string, number][] = [
    ['subtotal', b.subtotalCents], ['discount', b.discountCents], ['taxable', b.taxableCents],
    ['tax', b.taxCents], ['tip', b.tip.cents], ['total', b.totalCents],
  ];
  for (const [name, value] of amounts) {
    if (!Number.isSafeInteger(value) || value < 0) problems.push(`${name} is not a whole, non-negative number of cents (${value})`);
  }
  for (const [i, l] of b.lines.entries()) {
    if (l.lineTotalCents !== l.unitCents * l.quantity) problems.push(`line ${i} total is not unit price x quantity`);
  }
  if (b.subtotalCents !== b.lines.reduce((sum, l) => sum + l.lineTotalCents, 0)) problems.push('subtotal is not the sum of the lines');
  if (b.discountCents > b.subtotalCents) problems.push('discount is more than the subtotal');
  if (b.taxableCents !== b.subtotalCents - b.discountCents) problems.push('taxable amount is not subtotal minus discount');
  if (b.totalCents !== b.taxableCents + b.taxCents + b.tip.cents) problems.push('total is not taxable + tax + tip');
  return problems;
}

/**
 * Comparing what the customer was shown with what the service computes.
 *
 * The page sends the amounts it is displaying (its "claim"). The service prices the
 * order itself and calls `compareClaimed`; any difference means the customer is
 * looking at something that is not what they would be charged, so the order is held
 * until they have seen the corrected figures and confirmed (docs/decisions-detailed.md D23).
 * A claim is only ever checked against the service's own result, never trusted.
 */
import { formatCents, type Cents } from './money.js';
import type { Breakdown } from './pricing.js';

/** The amounts the page is showing. Anything left out is simply not checked. */
export interface Claimed {
  /** Unit price (base + toppings) shown for each pizza line, in order. */
  lines?: { unitCents: Cents }[];
  subtotalCents?: Cents;
  discountCents?: Cents;
  taxCents?: Cents;
  tipCents?: Cents;
  totalCents?: Cents;
}

export interface Difference {
  /** Which figure, e.g. 'subtotal', 'total', 'lines[1]'. */
  field: string;
  claimed: unknown;
  actual: unknown;
  /** Plain language for the customer. */
  message: string;
}

/** Show a claimed value, whatever it is: cents as dollars, anything else as it came. */
function show(value: unknown): string {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? formatCents(value) : JSON.stringify(value) ?? 'nothing';
}

/** Every way the claim differs from the breakdown; empty means everything matches. */
export function compareClaimed(claimed: Claimed | null | undefined, actual: Breakdown): Difference[] {
  if (!claimed || typeof claimed !== 'object') return [];
  const differences: Difference[] = [];

  if (claimed.lines !== undefined) {
    const shown = Array.isArray(claimed.lines) ? claimed.lines : [];
    if (shown.length !== actual.lines.length) {
      differences.push({
        field: 'lines',
        claimed: shown.length,
        actual: actual.lines.length,
        message: `Your order has ${actual.lines.length} pizza line(s), but ${shown.length} were shown`,
      });
    } else {
      actual.lines.forEach((line, i) => {
        const was = shown[i]?.unitCents;
        if (was !== line.unitCents) {
          differences.push({
            field: `lines[${i}]`,
            claimed: was,
            actual: line.unitCents,
            message: `Pizza ${i + 1}: you were shown ${show(was)} each, but it is ${show(line.unitCents)} each`,
          });
        }
      });
    }
  }

  const amounts: [keyof Omit<Claimed, 'lines'>, string, Cents][] = [
    ['subtotalCents', 'Subtotal', actual.subtotalCents],
    ['discountCents', 'Discount', actual.discountCents],
    ['taxCents', 'Tax', actual.taxCents],
    ['tipCents', 'Tip', actual.tip.cents],
    ['totalCents', 'Total', actual.totalCents],
  ];
  for (const [key, label, value] of amounts) {
    const was = claimed[key];
    if (was !== undefined && was !== value) {
      differences.push({
        field: label.toLowerCase(),
        claimed: was,
        actual: value,
        message: `${label}: you were shown ${show(was)}, but it is ${show(value)}`,
      });
    }
  }
  return differences;
}

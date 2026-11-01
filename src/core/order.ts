/**
 * The vocabulary shared by the pricing stages: what an order looks like going in,
 * what can be wrong with it, and the limits it must stay within. No logic here.
 */
import type { Cents } from './money.js';

// ------------------------------------------------------------------ input ---

export interface OrderLineInput {
  /** Size code, e.g. 'medium'. */
  size: string;
  quantity: number;
  /** Topping codes. Each topping may appear at most once per pizza. */
  toppings: string[];
}

export type TipInput =
  | { mode: 'none' }
  | { mode: 'amount'; cents: Cents }
  | { mode: 'percent'; bps: number }; // 1800 = 18%

export interface OrderInput {
  lines: OrderLineInput[];
  tip?: TipInput;
  /** Codes the customer entered, in the order entered. Case and surrounding spaces are ignored. */
  promoCodes?: string[];
}

/** Sanity limits. Documented in assumptions.md; they stop typos, not real orders. */
export const LIMITS = {
  maxLines: 50,
  maxQuantity: 100,
  maxTipCents: 50_000, // $500
  maxTipBps: 10_000, // 100%
} as const;

/**
 * A very large tip is held until the customer confirms it, in case of a slip of the finger
 * (a stray zero turns $5 into $50). It is "very large" when it is at least this share of the
 * bill, except on a small order where a big share is still a small sum.
 */
export const TIP_CONFIRMATION = {
  /** 5000 bps = 50% of the bill. */
  minShareBps: 5000,
  /** A bill strictly under this ($40.00) never needs confirming. */
  exemptBillBelowCents: 4000,
} as const;

// ----------------------------------------------------------------- issues ---

export type IssueCode =
  | 'empty_order'
  | 'too_many_lines'
  | 'invalid_quantity'
  | 'unknown_size'
  | 'unknown_topping'
  | 'duplicate_topping'
  | 'invalid_tip';

/** Something wrong with the order itself. Reported all at once, with where and why. */
export interface Issue {
  code: IssueCode;
  /** Where in the input, e.g. 'lines[1].toppings[0]'. */
  path: string;
  message: string;
}

// ------------------------------------------------------------ priced lines ---

export interface PricedLine {
  size: { code: string; label: string; priceCents: Cents; priceId: number };
  quantity: number;
  toppings: { code: string; label: string; priceCents: Cents; priceId: number }[];
  /** One pizza: base + toppings. */
  unitCents: Cents;
  /** unitCents * quantity. */
  lineTotalCents: Cents;
}

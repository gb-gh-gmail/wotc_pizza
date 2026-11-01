import type { DatabaseSync } from 'node:sqlite';
import { compareClaimed, type Claimed, type Difference } from '../../core/claims.js';
import { priceOrder, type Breakdown, type Issue, type OrderInput } from '../../core/pricing.js';
import { findSnapshot } from '../menu/snapshots.js';
import { loadPromos } from '../promos/repo.js';

export interface QuoteRequest {
  /** The menu the customer was shown; the order is priced from its prices, not today's. */
  menuToken: string;
  order: OrderInput;
  /** The amounts the page is displaying, to be checked against ours. Optional. */
  claimed?: Claimed;
}

export type QuoteOutcome =
  | {
      kind: 'quote';
      breakdown: Breakdown;
      /** How the page's figures differ from ours. Empty means everything matches. */
      differences: Difference[];
      matches: boolean;
      menuToken: string;
      /** When the prices in this quote stop being honoured. */
      expiresAt: string;
    }
  | { kind: 'menu_unknown' }
  | { kind: 'menu_expired'; expiredAt: string }
  | { kind: 'invalid_order'; issues: Issue[] };

/**
 * Price an order exactly as it would be charged, and check it against what the page
 * shows. The one place that turns a customer's order into authoritative figures, for
 * both the running total and (later) placing the order. It reads, and writes nothing.
 *
 * It calls DOWN only: snapshot lookup, the live promo table, then the pricing engine.
 * Promo validation is stage 2 of the engine, so it happens inside this one call and
 * every call re-validates every code from scratch against the promos as they are now.
 */
export function quoteOrder(db: DatabaseSync, request: QuoteRequest, now: Date): QuoteOutcome {
  const snapshot = findSnapshot(db, request.menuToken, now);
  if (!snapshot) return { kind: 'menu_unknown' };
  if (snapshot.expired) return { kind: 'menu_expired', expiredAt: snapshot.expiresAt };

  // Prices come from the snapshot the customer saw; promos are read live (D23).
  const result = priceOrder(request.order, snapshot.data, loadPromos(db, now));
  if (!result.ok) return { kind: 'invalid_order', issues: result.issues };

  const differences = compareClaimed(request.claimed, result.breakdown);
  return {
    kind: 'quote',
    breakdown: result.breakdown,
    differences,
    matches: differences.length === 0,
    menuToken: snapshot.token,
    expiresAt: snapshot.expiresAt,
  };
}

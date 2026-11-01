import type { MenuSnapshot } from '../../src/core/menu.js';
import { toppingPriceCents } from '../../src/core/menu.js';
import type { PromoDef } from '../../src/core/pricing.js';

const meta = { id: 1, name: 'Test Menu', description: null, effectiveFrom: '2026-01-01T00:00:00.000Z', effectiveTo: null };
const taxRate = { id: 1, name: 'Sales tax', rateBps: 650 };
const pricedAt = '2026-06-15T12:00:00.000Z';

const basic = { code: 'basic', label: 'Basic toppings' };
const premium = { code: 'premium', label: 'Premium toppings' };

/**
 * The menu from the brief with every price written out by hand (not computed), so a
 * mistake in the percentage logic cannot hide behind a fixture that shares it.
 * Small $5, medium $7, large $12; basic toppings 8%, premium 11%.
 */
export function briefMenu(overrides: Partial<MenuSnapshot> = {}): MenuSnapshot {
  return {
    menu: meta,
    sizes: [
      { code: 'small', label: 'Small', priceCents: 500, priceId: 1 },
      { code: 'medium', label: 'Medium', priceCents: 700, priceId: 2 },
      { code: 'large', label: 'Large', priceCents: 1200, priceId: 3 },
    ],
    toppings: [
      { code: 'pepperoni', label: 'Pepperoni', category: basic, price: { type: 'percentage', amount: 800 }, priceId: 4, pricesCents: { small: 40, medium: 56, large: 96 } },
      { code: 'sausage', label: 'Sausage', category: basic, price: { type: 'percentage', amount: 800 }, priceId: 5, pricesCents: { small: 40, medium: 56, large: 96 } },
      { code: 'bacon', label: 'Bacon', category: premium, price: { type: 'percentage', amount: 1100 }, priceId: 6, pricesCents: { small: 55, medium: 77, large: 132 } },
      { code: 'pineapple', label: 'Pineapple', category: premium, price: { type: 'percentage', amount: 1100 }, priceId: 7, pricesCents: { small: 55, medium: 77, large: 132 } },
    ],
    taxRate,
    pricedAt,
    ...overrides,
  };
}

/** A menu with chosen size prices and tax rate, toppings derived from their rules. For boundary tests. */
export function customMenu(sizePrices: Record<string, number>, taxRateBps = 650): MenuSnapshot {
  const base = briefMenu();
  const sizes = Object.entries(sizePrices).map(([code, priceCents], i) => ({ code, label: code, priceCents, priceId: 100 + i }));
  return {
    ...base,
    sizes,
    toppings: base.toppings.map((t) => ({
      ...t,
      pricesCents: Object.fromEntries(sizes.map((s) => [s.code, toppingPriceCents(t.price, s.priceCents)])),
    })),
    taxRate: { ...taxRate, rateBps: taxRateBps },
  };
}

/** The two promos from the brief, both exclusive (the default). */
export const briefPromos: PromoDef[] = [
  { code: 'ILOVEPIZZA', kind: 'percent_off', percentBps: 1000, amountCents: null, minSubtotalCents: null, exclusive: true },
  { code: 'SAVE5', kind: 'flat_off', percentBps: null, amountCents: 500, minSubtotalCents: 2000, exclusive: true },
];

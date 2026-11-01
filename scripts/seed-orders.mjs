// Place a set of sample orders by calling the real order service, the way a customer and the kitchen would.
// Nothing is written to the database directly, so every order goes through the same pricing, checks and
// order lifecycle as a real one. Useful for trying the kitchen screen and status pages with something on them.
//
//   npm run seed:orders              place the sample orders (refuses if the service already has orders)
//   npm run seed:orders -- --add     place them anyway, in addition to what is there
//
// Settings (environment variables):
//   ORDER_SERVICE_URL   where the order service is    (default http://127.0.0.1:3001)
//   BUILDER_URL         used only to print links      (default http://localhost:3000)
import { pathToFileURL } from 'node:url';

/**
 * The sample orders. `target` is the status each should end in; `change` places a second, changed
 * version; `cancel` cancels it. Sizes, toppings and promo codes are the ones in db/seed.sql.
 */
export const SEED_ORDERS = [
  {
    name: "delivered-with-promo",
    about: "Three pizzas loaded with toppings, the ILOVEPIZZA promo and a 20% tip; delivered",
    order: {
      lines: [
        { size: "large", quantity: 2, toppings: ["pepperoni", "sausage", "black_olives", "extra_cheese", "pineapple", "bacon"] },
        { size: "medium", quantity: 1, toppings: ["sausage", "black_olives", "chicken", "sun_dried_tomatoes", "artichoke_hearts", "bacon"] },
      ],
      promoCodes: ["ILOVEPIZZA"],
      tip: { mode: 'percent', bps: 2000 },
    },
    target: "DELIVERED",
    expectedTotalCents: 5539,
  },
  {
    name: "changed-then-cancelled",
    about: "Five medium pizzas and a 25% tip; changed once (more toppings), then cancelled by the customer",
    order: {
      lines: [
        { size: "medium", quantity: 3, toppings: ["pepperoni", "black_olives", "sausage", "extra_cheese", "pineapple", "bacon"] },
        { size: "medium", quantity: 2, toppings: ["bacon", "chicken", "sun_dried_tomatoes", "pineapple", "black_olives", "sausage", "green_peppers", "extra_cheese"] },
      ],
      promoCodes: ["ILOVEPIZZA"],
      tip: { mode: 'percent', bps: 2500 },
    },
    change: {
      lines: [
        { size: "medium", quantity: 3, toppings: ["pepperoni", "sausage", "extra_cheese", "black_olives", "bacon", "pineapple"] },
        { size: "medium", quantity: 2, toppings: ["sausage", "extra_cheese", "black_olives", "green_peppers", "bacon", "chicken", "sun_dried_tomatoes", "pineapple", "pepperoni", "onions"] },
      ],
      promoCodes: ["ILOVEPIZZA"],
      tip: { mode: 'percent', bps: 2500 },
    },
    cancel: { by: "customer" },
    expectedTotalCents: 7095,
    expectedOriginalTotalCents: 6826,
  },
  {
    name: "kitchen-cancelled-early",
    about: "Five large pizzas and a 15% tip; cancelled by the kitchen before it was started",
    order: {
      lines: [
        { size: "large", quantity: 5, toppings: ["pepperoni", "extra_cheese", "black_olives", "pineapple"] },
      ],
      tip: { mode: 'percent', bps: 1500 },
    },
    cancel: { by: "kitchen", reason: "Out of ...." },
    expectedTotalCents: 9921,
  },
  {
    name: "kitchen-cancelled-when-ready",
    about: "Six small pizzas with many toppings and a $25 tip; the kitchen cancelled it when it was ready for pickup",
    order: {
      lines: [
        { size: "small", quantity: 6, toppings: ["bacon", "chicken", "sun_dried_tomatoes", "garlic", "pineapple", "extra_cheese", "black_olives", "sausage", "artichoke_hearts"] },
      ],
      promoCodes: ["ILOVEPIZZA"],
      tip: { mode: 'amount', cents: 2500 },
    },
    advanceTo: "READY_FOR_PICKUP",
    cancel: { by: "kitchen", reason: "Delivery service no longer around" },
    expectedTotalCents: 7963,
  },
  {
    name: "delivered-large-tip",
    about: "Five large pizzas and a 75% tip, which has to be confirmed (the script confirms it); delivered",
    order: {
      lines: [
        { size: "large", quantity: 5, toppings: ["pepperoni", "extra_cheese", "black_olives"] },
      ],
      tip: { mode: 'percent', bps: 7500 },
    },
    target: "DELIVERED",
    expectedTotalCents: 13867,
  },
  {
    name: "delivered-save5",
    about: "Four large pizzas with the SAVE5 promo and a 15% tip; delivered",
    order: {
      lines: [
        { size: "large", quantity: 4, toppings: ["pepperoni", "extra_cheese", "black_olives"] },
      ],
      promoCodes: ["SAVE5"],
      tip: { mode: 'percent', bps: 1500 },
    },
    target: "DELIVERED",
    expectedTotalCents: 6677,
  },
  {
    name: "started-with-promo",
    about: "Three pizzas, ILOVEPIZZA and a $15 tip; the kitchen is cooking it",
    order: {
      lines: [
        { size: "medium", quantity: 1, toppings: ["sausage", "black_olives", "chicken", "sun_dried_tomatoes", "artichoke_hearts", "bacon", "pineapple", "green_peppers"] },
        { size: "large", quantity: 2, toppings: ["extra_cheese", "sausage", "chicken", "bacon"] },
      ],
      promoCodes: ["ILOVEPIZZA"],
      tip: { mode: 'amount', cents: 1500 },
    },
    target: "STARTED",
    expectedTotalCents: 5875,
  },
  {
    name: "ready-for-pickup",
    about: "Four pizzas loaded with toppings and a 17.5% tip; ready for pickup",
    order: {
      lines: [
        { size: "medium", quantity: 3, toppings: ["artichoke_hearts", "chicken", "black_olives", "sausage", "green_peppers", "garlic", "pineapple", "sun_dried_tomatoes", "bacon"] },
        { size: "small", quantity: 1, toppings: ["pepperoni", "chicken", "extra_cheese", "garlic"] },
      ],
      tip: { mode: 'percent', bps: 1750 },
    },
    target: "READY_FOR_PICKUP",
    expectedTotalCents: 5856,
  },
  {
    name: "waiting-for-kitchen",
    about: "Two large pizzas with SAVE5 and a 10% tip; the kitchen has not started it",
    order: {
      lines: [
        { size: "large", quantity: 2, toppings: ["pepperoni", "black_olives", "extra_cheese"] },
      ],
      promoCodes: ["SAVE5"],
      tip: { mode: 'percent', bps: 1000 },
    },
    target: "NOT_STARTED",
    expectedTotalCents: 2901,
  },
];

const NEXT = { NOT_STARTED: 'STARTED', STARTED: 'READY_FOR_PICKUP', READY_FOR_PICKUP: 'DELIVERED' };

/** A small client for the order service. `fetchImpl` is injectable for tests. */
function client(serviceUrl, fetchImpl = fetch) {
  return async function call(method, path, body, headers = {}) {
    const res = await fetchImpl(serviceUrl + path, {
      method,
      headers: { 'content-type': 'application/json', ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
    return { status: res.status, ok: res.ok, json: await res.json().catch(() => null) };
  };
}

/** What a customer's page claims after checking the total: exactly the figures the service returned. */
const claimFrom = (q) => ({
  lines: q.lines.map((l) => ({ unitCents: l.unitCents })),
  subtotalCents: q.subtotalCents,
  discountCents: q.discountCents,
  taxCents: q.taxCents,
  tipCents: q.tip.cents,
  totalCents: q.totalCents,
});

function fail(step, res) {
  const detail = res.json?.issues ? res.json.issues.map((i) => i.message).join('; ') : (res.json?.message ?? `HTTP ${res.status}`);
  return new Error(`${step}: ${detail}`);
}

/**
 * Place the sample orders and move them to their intended states.
 * Returns one result per order. Throws if the service cannot be reached or refuses something unexpected.
 */
export async function seedOrders({ serviceUrl = 'http://127.0.0.1:3001', add = false, log = () => {}, fetchImpl = fetch } = {}) {
  const call = client(serviceUrl, fetchImpl);

  // Refuse to pile sample orders on top of existing ones unless asked.
  const existing = await call('GET', '/kitchen/orders?include=closed').catch((err) => {
    throw new Error(`Cannot reach the order service at ${serviceUrl} (${err.message}). Is it running? Try: npm run dev`);
  });
  if (!existing.ok) throw fail('Listing existing orders', existing);
  const count = existing.json.orders.length;
  if (count > 0 && !add) return { skipped: true, existing: count, results: [] };

  const runId = Date.now().toString(36);
  const results = [];

  for (const spec of SEED_ORDERS) {
    // A fresh menu session per order, like a customer opening the page.
    const menu = await call('GET', '/menu');
    if (!menu.ok) throw fail('Loading the menu (is the database seeded? start with SEED_DB=true)', menu);

    const quote = await call('POST', '/quote', { menuToken: menu.json.menuToken, order: spec.order });
    if (!quote.ok) throw fail(`${spec.name}: checking the total`, quote);
    const q = quote.json.quote;

    // A very large tip has to be confirmed by the customer; the script plays that part.
    const confirmations = q.tip.needsConfirmation ? { largeTipCents: q.tip.cents } : undefined;
    const placed = await call(
      'POST',
      '/orders',
      { menuToken: menu.json.menuToken, order: spec.order, claimed: claimFrom(q), ...(confirmations ? { confirmations } : {}) },
      { 'idempotency-key': `seed-${runId}-${spec.name}` },
    );
    if (placed.status !== 201) throw fail(`${spec.name}: placing the order`, placed);
    let order = placed.json.order;
    log(`${"placed".padEnd(18)}${spec.name}`);

    if (spec.change) {
      const freshMenu = await call('GET', '/menu');
      const changedQuote = await call('POST', '/quote', { menuToken: freshMenu.json.menuToken, order: spec.change });
      if (!changedQuote.ok) throw fail(`${spec.name}: checking the changed total`, changedQuote);
      const cq = changedQuote.json.quote;
      const saved = await call(
        'PUT',
        `/orders/${order.id}`,
        { menuToken: freshMenu.json.menuToken, order: spec.change, claimed: claimFrom(cq), expectedVersion: order.version },
        { 'idempotency-key': `seed-${runId}-${spec.name}-change` },
      );
      if (!saved.ok) throw fail(`${spec.name}: changing the order`, saved);
      order = saved.json.order;
      log(`${"changed".padEnd(18)}${spec.name}`);
    }

    // The kitchen moves it along, one step at a time, each step stating the status it expects.
    const goal = spec.target ?? spec.advanceTo;
    let status = order.status;
    while (goal && status !== goal) {
      if (!NEXT[status]) throw new Error(`${spec.name}: cannot go from ${status} to ${goal}`);
      const step = await call('POST', `/kitchen/orders/${order.id}/advance`, { expectedStatus: status });
      if (!step.ok) throw fail(`${spec.name}: moving the order on`, step);
      status = step.json.order.status;
      log(`${status.padEnd(18)}${spec.name}`);
    }

    if (spec.cancel) {
      const cancelled =
        spec.cancel.by === 'customer'
          ? await call('POST', `/orders/${order.id}/cancel`, { reason: spec.cancel.reason, expectedStatus: status })
          : await call('POST', `/kitchen/orders/${order.id}/cancel`, { reason: spec.cancel.reason });
      if (!cancelled.ok) throw fail(`${spec.name}: cancelling`, cancelled);
      log(`${"cancelled".padEnd(18)}${spec.name} (by ${spec.cancel.by})`);
    }

    const final = await call('GET', `/orders/${order.id}`);
    results.push({ name: spec.name, about: spec.about, id: order.id, status: final.json.order.status, totalCents: final.json.order.totalCents, revision: final.json.order.revision });
  }

  return { skipped: false, existing: count, results };
}

const dollars = (c) => `$${Math.floor(c / 100)}.${String(c % 100).padStart(2, '0')}`;

// Run as a command (not when imported by a test).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const serviceUrl = (process.env.ORDER_SERVICE_URL || 'http://127.0.0.1:3001').replace(/\/+$/, '');
  const builderUrl = (process.env.BUILDER_URL || 'http://localhost:3000').replace(/\/+$/, '');
  try {
    const outcome = await seedOrders({ serviceUrl, add: process.argv.includes('--add'), log: (line) => console.log('  ' + line) });
    if (outcome.skipped) {
      console.log(`The order service already has ${outcome.existing} order(s), so nothing was added.`);
      console.log('To start clean:  stop the service, run  npm run db:reset,  start it again, then run this.');
      console.log('To add the samples anyway:  npm run seed:orders -- --add');
      process.exit(0);
    }
    console.log(`\nPlaced ${outcome.results.length} sample orders:\n`);
    for (const r of outcome.results) {
      console.log(`  ${r.name.padEnd(20)} ${r.status.padEnd(17)} ${dollars(r.totalCents).padStart(8)}${r.revision > 1 ? '  (changed)' : ''}`);
      console.log(`  ${' '.repeat(20)} ${r.about}`);
      console.log(`  ${' '.repeat(20)} ${builderUrl}/track/${r.id}`);
    }
    console.log(`\nKitchen screen: ${serviceUrl}/kitchen   (tick "Show delivered & cancelled" to see them all)`);
  } catch (err) {
    console.error(`\n${err.message}`);
    process.exit(1);
  }
}

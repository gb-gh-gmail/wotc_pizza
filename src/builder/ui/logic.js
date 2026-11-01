// The order page's decisions, with no DOM in them, so they can be tested without a browser.
// app.js is only wiring: it draws the page and calls these.
//
// Money is whole cents and percentages whole basis points (100 bps = 1%) throughout; text the
// customer types is turned into those without ever touching floating point.

// ------------------------------------------------------------------ money ---

/** 1234 -> "$12.34". Display only. */
export function money(cents) {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  return `${sign}$${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}

/**
 * Turn what the customer typed ("5", "5.5", "5.50", ".5") into hundredths as a whole number
 * (500, 550, 550, 50). Dollars become cents; percentages become basis points. Anything else
 * (negative, three decimals, letters, "1e3", blank) is refused.
 */
export function parseHundredths(text) {
  const t = String(text ?? '').trim();
  if (!/^(\d{1,7}(\.\d{0,2})?|\.\d{1,2})$/.test(t)) return null;
  const [whole = '0', fraction = ''] = t.split('.');
  return Number(whole || '0') * 100 + Number((fraction + '00').slice(0, 2));
}

/** The tip the customer entered, as the service expects it, or a message saying what is wrong. */
export function tipFromInput(mode, text) {
  if (mode === 'none') return { ok: true, tip: { mode: 'none' } };
  const value = parseHundredths(text);
  if (mode === 'amount') {
    return value === null
      ? { ok: false, message: 'Enter the tip as dollars, like 5 or 5.50' }
      : { ok: true, tip: { mode: 'amount', cents: value } };
  }
  if (mode === 'percent') {
    return value === null
      ? { ok: false, message: 'Enter the tip as a percentage, like 18 or 18.5' }
      : { ok: true, tip: { mode: 'percent', bps: value } };
  }
  return { ok: false, message: 'Choose a tip option' };
}

/** Promo box text -> codes: trimmed and upper-cased; blanks dropped. */
export function codesFromInput(text) {
  return String(text ?? '')
    .split(/[\s,]+/)
    .map((c) => c.trim().toUpperCase())
    .filter(Boolean);
}

// ------------------------------------------------------------------ quote ---

/**
 * What to send to /quote. `shown` is what the page is displaying right now:
 *   lines     unit price per pizza line
 *   subtotal  the pre-promo subtotal
 *   figures   the server's discount/tax/tip/total currently on screen, or null if none are
 *             (never sent when the order has changed since, because they would no longer be on screen)
 */
export function buildQuoteRequest({ menuToken, lines, tip, promoCodes, shown }) {
  const claimed = {
    lines: shown.lines.map((unitCents) => ({ unitCents })),
    subtotalCents: shown.subtotal,
  };
  if (shown.figures) {
    claimed.discountCents = shown.figures.discountCents;
    claimed.taxCents = shown.figures.taxCents;
    claimed.tipCents = shown.figures.tipCents;
    claimed.totalCents = shown.figures.totalCents;
  }
  return {
    menuToken,
    order: {
      lines: lines.map((l) => ({ size: l.size, quantity: l.quantity, toppings: [...l.toppings] })),
      tip,
      promoCodes,
    },
    claimed,
  };
}

/**
 * Read a successful quote and decide what the customer needs to be told.
 *
 *   appliedBefore  codes that were applied in the quote the customer was last looking at
 *
 * A code that WAS applied and is now refused is a change to the price they saw, so it needs
 * their OK. A code they just typed that is refused is only a message beside the box.
 */
export function interpretQuote(response, { appliedBefore }) {
  const { quote, differences } = response;
  // (An older quote without the tip flag simply has nothing to confirm.)
  const refused = quote.promos.filter((p) => !p.applied);
  const applied = quote.promos.filter((p) => p.applied).map((p) => p.code);
  const removed = refused.filter((p) => appliedBefore.includes(p.code));
  const rejectedNew = refused.filter((p) => !appliedBefore.includes(p.code));

  const notices = [];
  for (const p of removed) notices.push(`${p.code} no longer applies: ${p.message}.`);
  // A promo that stopped applying also shows up as differing figures; don't say the same thing twice.
  const priceDiffs = differences.filter((d) => !(removed.length && ['discount', 'tax', 'tip', 'total'].includes(d.field)));
  for (const d of priceDiffs) notices.push(d.message + '.');
  const priceChanged = notices.length > 0;
  if (priceChanged) notices.push(`Your new total is ${money(quote.totalCents)}.`);

  // A very large tip is held for confirmation too, in case of a slip of the finger.
  const bigTip = quote.tip?.needsConfirmation === true;
  if (bigTip) {
    notices.push(
      `Your tip of ${money(quote.tip.cents)} is half your bill or more (your bill is ${money(quote.taxableCents + quote.taxCents)} before the tip). Please make sure that is what you intend.`,
    );
  }

  return {
    appliedCodes: applied,
    removedCodes: removed.map((p) => p.code),
    rejectedNew: rejectedNew.map((p) => ({ code: p.code, message: p.message })),
    notices,
    bigTip,
    needsConfirm: removed.length > 0 || differences.length > 0 || bigTip,
    // What the confirm button says: about the tip when that is all there is to confirm.
    acceptLabel: bigTip && !priceChanged ? 'Yes, the tip is correct' : bigTip ? 'Accept updated total and tip' : 'Accept updated total',
  };
}

// ------------------------------------------------------------------ order ---

/** The figures from a quote, in the shape the service compares them in: what the page is claiming to have shown. */
export function claimFromQuote(quote) {
  return {
    lines: quote.lines.map((l) => ({ unitCents: l.unitCents })),
    subtotalCents: quote.subtotalCents,
    discountCents: quote.discountCents,
    taxCents: quote.taxCents,
    tipCents: quote.tip.cents,
    totalCents: quote.totalCents,
  };
}

/**
 * What to send to place the order. `quote` is the quote the customer has SEEN AND ACCEPTED, so
 * it is both the claim to check and, if its tip was a very large one, the amount they confirmed.
 */
export function buildPlaceRequest({ menuToken, lines, tip, promoCodes, quote }) {
  const body = {
    menuToken,
    order: {
      lines: lines.map((l) => ({ size: l.size, quantity: l.quantity, toppings: [...l.toppings] })),
      tip,
      promoCodes,
    },
    claimed: claimFromQuote(quote),
  };
  if (quote.tip?.needsConfirmation) body.confirmations = { largeTipCents: quote.tip.cents };
  return body;
}

/**
 * The service held the order (409 confirmation_required). What to tell the customer: every
 * reason it gave, in words, ending with the new total. Every code the service says it removed
 * is treated as one the customer had applied, so each is named.
 */
export function describeHold(data, { appliedBefore }) {
  const removedPromos = data.removedPromos ?? [];
  const result = interpretQuote(
    { quote: data.quote, differences: data.differences ?? [] },
    { appliedBefore: [...new Set([...appliedBefore, ...removedPromos])] },
  );
  const notices = result.notices.length
    ? result.notices
    : [`${data.message ?? 'Please review your order'}. Your total is ${money(data.quote.totalCents)}.`];
  return { ...result, notices };
}

/** A key that identifies one attempt to place an order, so sending it twice cannot place it twice. */
export function newIdempotencyKey(cryptoLike = globalThis.crypto) {
  const bytes = new Uint8Array(16);
  if (cryptoLike && typeof cryptoLike.getRandomValues === 'function') cryptoLike.getRandomValues(bytes);
  else for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  return 'ord-' + [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// ---------------------------------------------------------------- editing ---

/** 550 -> "5.50"; used to put a saved dollar tip back in the tip box. */
const dollarsText = (cents) => `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, '0')}`;
/** 1800 -> "18", 1850 -> "18.5", 1825 -> "18.25"; a saved percentage tip back in the tip box. */
const percentText = (bps) => {
  const frac = String(bps % 100).padStart(2, '0').replace(/0$/, '');
  return bps % 100 === 0 ? String(Math.floor(bps / 100)) : `${Math.floor(bps / 100)}.${frac}`;
};

/** The tip box contents that reproduce a saved order's tip. */
export function tipInputsFromOrder(tip) {
  if (!tip || !tip.input) return { mode: 'none', text: '' };
  if (tip.mode === 'amount') return { mode: 'amount', text: dollarsText(tip.input) };
  if (tip.mode === 'percent') return { mode: 'percent', text: percentText(tip.input) };
  return { mode: 'none', text: '' };
}

/**
 * Rebuild an order's pizzas for editing against the menu now on offer. Anything that is no longer
 * on the menu is dropped, and reported so the customer is told rather than surprised.
 */
export function linesFromOrder(order, menu) {
  const sizes = new Set(menu.sizes.map((s) => s.code));
  const toppings = new Set(menu.toppings.map((t) => t.code));
  const lines = [];
  const dropped = [];
  for (const line of order.lines) {
    if (!sizes.has(line.size.code)) {
      dropped.push(`${line.quantity} × ${line.size.label} pizza`);
      continue;
    }
    const kept = new Set();
    for (const t of line.toppings) {
      if (toppings.has(t.code)) kept.add(t.code);
      else dropped.push(`${t.label} topping`);
    }
    lines.push({ size: line.size.code, quantity: line.quantity, toppings: kept });
  }
  return { lines, dropped };
}

/** "$1.38 more than your current order", "$2.00 less than ...", or "the same price as ...". */
export function describeDelta(deltaCents) {
  if (deltaCents === 0) return 'The same price as your current order';
  return `${money(Math.abs(deltaCents))} ${deltaCents > 0 ? 'more' : 'less'} than your current order`;
}

/**
 * How an updated quote compares with the order as it stands now, line by line of the bill. `effect`
 * is the change to what the customer pays: a bigger discount is a negative effect, so every
 * effect column adds up to the change in the total.
 */
export function compareToCurrent(current, quote) {
  const rows = [
    { label: 'Subtotal', was: current.subtotalCents, now: quote.subtotalCents, sign: 1 },
    { label: 'Promo discount', was: current.discountCents, now: quote.discountCents, sign: -1 },
    { label: 'Tax', was: current.taxCents, now: quote.taxCents, sign: 1 },
    { label: 'Tip', was: current.tip.cents, now: quote.tip.cents, sign: 1 },
    { label: 'Total', was: current.totalCents, now: quote.totalCents, sign: 1 },
  ].map(({ sign, ...r }) => ({ ...r, effect: sign * (r.now - r.was) }));
  const totalDelta = quote.totalCents - current.totalCents;
  return { rows, totalDelta, text: describeDelta(totalDelta) };
}

/** What to tell a customer whose order has moved past the point where it can be changed. */
export function lockedMessage(status) {
  switch (status) {
    case 'CANCELLED':
      return 'This order has been cancelled, so it can no longer be changed.';
    case 'DELIVERED':
      return 'Your order has already been delivered, so it can no longer be changed.';
    case 'READY_FOR_PICKUP':
      return 'Your order is ready for pickup, so it can no longer be changed.';
    default:
      return 'The kitchen has already started your order, so it can no longer be changed.';
  }
}

/**
 * Looking at the order while the customer edits it: can the edit carry on?
 *   'ok'      yes
 *   'locked'  the order is no longer Not Started: it cannot be changed any more, and the customer
 *             must be told straight away, even half-way through an edit
 *   'changed' someone changed it (another window) since this edit began
 * `order` is null when it could not be read; that is not a reason to alarm anyone, so it is 'ok'
 * and the next look decides.
 */
export function watchVerdict(order, { version }) {
  if (!order) return { verdict: 'ok' };
  if (order.status !== 'NOT_STARTED' || order.canEdit === false) return { verdict: 'locked', message: lockedMessage(order.status) };
  if (order.version !== version) {
    return { verdict: 'changed', message: 'This order was changed somewhere else. Reload it to see the latest version before making changes.' };
  }
  return { verdict: 'ok' };
}

// ------------------------------------------------------------- live updates ---

/**
 * Wait until calls have stopped for `ms`, then run `fn` once with the LAST call's arguments. A burst of
 * rapid changes therefore produces one run, for the final state. `timers` is injectable for tests; the
 * defaults are wrapped because a browser's setTimeout refuses to run as a method of another object.
 */
export function debounce(fn, ms, timers = { setTimeout: (f, t) => setTimeout(f, t), clearTimeout: (h) => clearTimeout(h) }) {
  let handle = null;
  let lastArgs = [];
  const run = () => {
    handle = null;
    fn(...lastArgs);
  };
  const debounced = (...args) => {
    lastArgs = args;
    if (handle !== null) timers.clearTimeout(handle);
    handle = timers.setTimeout(run, ms);
  };
  /** Forget any run that is waiting. */
  debounced.cancel = () => {
    if (handle !== null) timers.clearTimeout(handle);
    handle = null;
  };
  /** Is a run waiting? */
  debounced.pending = () => handle !== null;
  return debounced;
}

/**
 * "Last one wins" for requests that can overlap: take a ticket when a request starts; when its answer
 * arrives, use it only if no newer ticket has been taken (and nothing has invalidated it) since.
 */
export function latestOnly() {
  let current = 0;
  return {
    next: () => ++current,
    isLatest: (ticket) => ticket === current,
    /** Make every ticket taken so far out of date, e.g. because the order has changed again. */
    invalidate: () => {
      current++;
    },
  };
}

// ------------------------------------------------------------------ state ---

/** Statuses of the quote, in the order a customer meets them. */
export const STATUS = {
  STALE: 'stale', // the order changed since the last check (or it was never checked)
  CHECKING: 'checking', // a quote is in flight
  READY: 'ready', // checked, nothing differs
  NEEDS_CONFIRM: 'needs_confirm', // something differs: held until the customer accepts
  CONFIRMED: 'confirmed', // the customer accepted the updated figures
  EXPIRED: 'expired', // the session timed out
  ERROR: 'error', // the check could not be completed
  LOCKED: 'locked', // the order being changed has moved on and can no longer be changed
};

/** Place order is available only for a checked order with nothing left to confirm. */
export function canPlaceOrder(status) {
  return status === STATUS.READY || status === STATUS.CONFIRMED;
}

/** Why Place order is disabled, in words, or null when it is enabled. */
export function whyNotPlaceable(status) {
  switch (status) {
    case STATUS.READY:
    case STATUS.CONFIRMED:
      return null;
    case STATUS.CHECKING:
      return 'Checking your total…';
    case STATUS.NEEDS_CONFIRM:
      return 'Your prices changed. Review them and accept the updated total to continue.';
    case STATUS.EXPIRED:
      return 'Your session timed out. Get new prices to continue.';
    case STATUS.LOCKED:
      return 'This order can no longer be changed.';
    case STATUS.ERROR:
      return 'We could not check your total. Please try again.';
    case STATUS.STALE:
      return 'Your total is out of date.';
    default:
      return 'Check your total before placing the order.';
  }
}

// ------------------------------------------------------------------ timer ---

/**
 * Seconds left until `expiresAt`, measured on the SERVER's clock: the gap between the server's
 * time and the device's time when the menu loaded is applied to the device clock, so a wrong
 * device clock doesn't make the countdown wrong.
 */
export function secondsLeft({ expiresAt, serverTime, loadedAtMs, nowMs }) {
  const elapsedMs = nowMs - loadedAtMs;
  const serverNowMs = Date.parse(serverTime) + elapsedMs;
  return Math.max(0, Math.ceil((Date.parse(expiresAt) - serverNowMs) / 1000));
}

/** 1800 -> "30:00", 65 -> "1:05". */
export function formatCountdown(seconds) {
  const s = Math.max(0, Math.floor(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

// -------------------------------------------------------------- after reload ---

/**
 * Keep what the customer already built when the menu is reloaded (a new session): keep every
 * pizza whose size is still sold, drop toppings no longer sold, and report what was removed.
 */
export function carryOver(lines, menu) {
  const sizes = new Set(menu.sizes.map((s) => s.code));
  const toppings = new Set(menu.toppings.map((t) => t.code));
  const kept = [];
  const dropped = [];
  for (const line of lines) {
    if (!sizes.has(line.size)) {
      dropped.push(`${line.quantity} × ${line.size} pizza`);
      continue;
    }
    const still = [...line.toppings].filter((t) => toppings.has(t));
    for (const t of line.toppings) if (!toppings.has(t)) dropped.push(`${t} topping`);
    kept.push({ ...line, toppings: new Set(still) });
  }
  return { lines: kept, dropped };
}

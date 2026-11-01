import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
// @ts-expect-error - plain browser JavaScript, imported here only so its decisions can be tested
import * as page from '../../src/builder/ui/logic.js';

const {
  money, parseHundredths, tipFromInput, codesFromInput, buildQuoteRequest, interpretQuote,
  claimFromQuote, buildPlaceRequest, describeHold, newIdempotencyKey,
  tipInputsFromOrder, linesFromOrder, describeDelta, compareToCurrent, lockedMessage, watchVerdict,
  debounce, latestOnly,
  STATUS, canPlaceOrder, whyNotPlaceable, secondsLeft, formatCountdown, carryOver,
} = page;

describe('parseHundredths: what the customer typed -> whole cents or basis points', () => {
  it.each([
    ['5', 500], ['5.5', 550], ['5.50', 550], ['5.', 500], ['.5', 50], ['.05', 5], ['0', 0], ['0.00', 0],
    ['18', 1800], ['18.5', 1850], [' 12.34 ', 1234], ['1234567.89', 123456789],
  ])('%j -> %j', (text, expected) => {
    expect(parseHundredths(text)).toBe(expected);
  });

  it.each(['', '  ', '.', 'abc', '5.555', '-5', '+5', '1e3', '5,50', '$5', '5 0', '12345678', null, undefined])(
    'refuses %j',
    (text) => expect(parseHundredths(text)).toBeNull(),
  );

  it('never goes through floating point (0.07 and 1.15 are the classic traps)', () => {
    expect(parseHundredths('0.07')).toBe(7); // 0.07 * 100 = 7.000000000000001 in floating point
    expect(parseHundredths('1.15')).toBe(115); // 1.15 * 100 = 114.99999999999999
    expect(parseHundredths('8.2')).toBe(820);
  });
});

describe('tipFromInput', () => {
  it('none ignores whatever is in the box', () => {
    expect(tipFromInput('none', 'rubbish')).toEqual({ ok: true, tip: { mode: 'none' } });
  });
  it('dollars become cents, percent becomes basis points', () => {
    expect(tipFromInput('amount', '5.5')).toEqual({ ok: true, tip: { mode: 'amount', cents: 550 } });
    expect(tipFromInput('percent', '18.5')).toEqual({ ok: true, tip: { mode: 'percent', bps: 1850 } });
  });
  it('says what is wrong, in terms of what the customer is entering', () => {
    expect(tipFromInput('amount', 'five')).toEqual({ ok: false, message: 'Enter the tip as dollars, like 5 or 5.50' });
    expect(tipFromInput('percent', '-3')).toEqual({ ok: false, message: 'Enter the tip as a percentage, like 18 or 18.5' });
    expect(tipFromInput('amount', '')).toMatchObject({ ok: false });
    expect(tipFromInput('bogus', '5')).toMatchObject({ ok: false });
  });
});

describe('codesFromInput', () => {
  it('trims, upper-cases, splits on spaces and commas, drops blanks', () => {
    expect(codesFromInput('  save5 ')).toEqual(['SAVE5']);
    expect(codesFromInput('save5, ilovepizza')).toEqual(['SAVE5', 'ILOVEPIZZA']);
    expect(codesFromInput('')).toEqual([]);
    expect(codesFromInput(undefined)).toEqual([]);
  });
});

describe('buildQuoteRequest', () => {
  const lines = [{ size: 'large', quantity: 2, toppings: new Set(['bacon']) }];
  const base = { menuToken: 'tok', lines, tip: { mode: 'none' }, promoCodes: ['SAVE5'] };

  it('sends the order and the prices the page is showing', () => {
    const req = buildQuoteRequest({ ...base, shown: { lines: [1332], subtotal: 2664, figures: null } });
    expect(req).toEqual({
      menuToken: 'tok',
      order: { lines: [{ size: 'large', quantity: 2, toppings: ['bacon'] }], tip: { mode: 'none' }, promoCodes: ['SAVE5'] },
      claimed: { lines: [{ unitCents: 1332 }], subtotalCents: 2664 },
    });
  });

  it('also claims the discount, tax, tip and total when those figures are on screen', () => {
    const figures = { discountCents: 500, taxCents: 140, tipCents: 0, totalCents: 2304 };
    const req = buildQuoteRequest({ ...base, shown: { lines: [1332], subtotal: 2664, figures } });
    expect(req.claimed).toEqual({ lines: [{ unitCents: 1332 }], subtotalCents: 2664, ...figures });
  });

  it('turns the topping set into a plain list the service can read', () => {
    const req = buildQuoteRequest({ ...base, shown: { lines: [1], subtotal: 1, figures: null } });
    expect(Array.isArray(req.order.lines[0].toppings)).toBe(true);
  });
});

describe('interpretQuote: what the customer needs to be told', () => {
  const quote = (over: object = {}) => ({
    promos: [], totalCents: 2130, ...over,
  });
  const resp = (q: object, differences: object[] = []) => ({ quote: quote(q), differences });

  it('all clear: nothing to confirm', () => {
    const r = interpretQuote(resp({ promos: [{ code: 'SAVE5', applied: true, discountCents: 500 }] }), { appliedBefore: ['SAVE5'] });
    expect(r).toMatchObject({ appliedCodes: ['SAVE5'], removedCodes: [], rejectedNew: [], notices: [], needsConfirm: false });
  });

  it('a promo that WAS applied and now is not holds the order, with the reason and the new total', () => {
    const r = interpretQuote(
      resp({ promos: [{ code: 'SAVE5', applied: false, message: 'SAVE5 needs an order over $20.00 before tax' }] }),
      { appliedBefore: ['SAVE5'] },
    );
    expect(r.needsConfirm).toBe(true);
    expect(r.removedCodes).toEqual(['SAVE5']);
    expect(r.appliedCodes).toEqual([]);
    expect(r.notices).toEqual(['SAVE5 no longer applies: SAVE5 needs an order over $20.00 before tax.', 'Your new total is $21.30.']);
  });

  it('a code the customer just typed that is refused is a message by the box, not a price change', () => {
    const r = interpretQuote(
      resp({ promos: [{ code: 'NOPE', applied: false, message: '"NOPE" is not a valid promo code' }] }),
      { appliedBefore: [] },
    );
    expect(r.needsConfirm).toBe(false);
    expect(r.rejectedNew).toEqual([{ code: 'NOPE', message: '"NOPE" is not a valid promo code' }]);
    expect(r.notices).toEqual([]);
  });

  it('differing figures hold the order and are each explained', () => {
    const differences = [{ field: 'lines[0]', message: 'Pizza 1: you were shown $12.00 each, but it is $13.00 each' }, { field: 'subtotal', message: 'Subtotal: you were shown $12.00, but it is $13.00' }];
    const r = interpretQuote(resp({ totalCents: 1384 }, differences), { appliedBefore: [] });
    expect(r.needsConfirm).toBe(true);
    expect(r.notices).toEqual([
      'Pizza 1: you were shown $12.00 each, but it is $13.00 each.',
      'Subtotal: you were shown $12.00, but it is $13.00.',
      'Your new total is $13.84.',
    ]);
  });

  it('does not say the same thing twice when a dropped promo also changes the figures', () => {
    const differences = [
      { field: 'discount', message: 'Discount: you were shown $5.00, but it is $0.00' },
      { field: 'total', message: 'Total: you were shown $20.30, but it is $21.30' },
    ];
    const r = interpretQuote(
      resp({ promos: [{ code: 'SAVE5', applied: false, message: 'gone' }] }, differences),
      { appliedBefore: ['SAVE5'] },
    );
    expect(r.notices).toEqual(['SAVE5 no longer applies: gone.', 'Your new total is $21.30.']);
  });

  it('a mixed result: one code dropped, one new typo', () => {
    const r = interpretQuote(
      resp({ promos: [{ code: 'SAVE5', applied: false, message: 'm1' }, { code: 'NOPE', applied: false, message: 'm2' }] }),
      { appliedBefore: ['SAVE5'] },
    );
    expect(r.removedCodes).toEqual(['SAVE5']);
    expect(r.rejectedNew.map((x: { code: string }) => x.code)).toEqual(['NOPE']);
    expect(r.needsConfirm).toBe(true);
  });
});

describe('interpretQuote: a very large tip is held for confirmation', () => {
  const withTip = (tip: object, differences: object[] = [], promos: object[] = []) => ({
    quote: { promos, totalCents: 8112, taxableCents: 4800, taxCents: 312, tip: { mode: 'amount', ...tip } },
    differences,
  });

  it('holds the order, says how big the tip is against the bill, and words the button about the tip', () => {
    const r = interpretQuote(withTip({ cents: 3000, needsConfirmation: true }), { appliedBefore: [] });
    expect(r.bigTip).toBe(true);
    expect(r.needsConfirm).toBe(true);
    expect(r.acceptLabel).toBe('Yes, the tip is correct');
    expect(r.notices).toEqual([
      'Your tip of $30.00 is half your bill or more (your bill is $51.12 before the tip). Please make sure that is what you intend.',
    ]);
  });

  it('with a price change as well, one confirmation covers both and says so', () => {
    const r = interpretQuote(
      withTip({ cents: 3000, needsConfirmation: true }, [{ field: 'subtotal', message: 'Subtotal: you were shown $12.00, but it is $13.00' }]),
      { appliedBefore: [] },
    );
    expect(r.acceptLabel).toBe('Accept updated total and tip');
    expect(r.notices).toHaveLength(3); // the difference, the new total, then the tip
    expect(r.notices[0]).toBe('Subtotal: you were shown $12.00, but it is $13.00.');
    expect(r.notices[2]).toMatch(/Your tip of \$30\.00/);
  });

  it('an ordinary tip holds nothing', () => {
    const r = interpretQuote(withTip({ cents: 800, needsConfirmation: false }), { appliedBefore: [] });
    expect(r).toMatchObject({ bigTip: false, needsConfirm: false, notices: [], acceptLabel: 'Accept updated total' });
  });

  it('a price change alone keeps the usual button', () => {
    const r = interpretQuote(withTip({ cents: 800, needsConfirmation: false }, [{ field: 'total', message: 'Total: x' }]), { appliedBefore: [] });
    expect(r.acceptLabel).toBe('Accept updated total');
  });

  it('a quote with no tip block at all is simply not flagged', () => {
    expect(interpretQuote({ quote: { promos: [], totalCents: 100 }, differences: [] }, { appliedBefore: [] }).bigTip).toBe(false);
  });
});

describe('placing the order: what the page sends', () => {
  const quote = (over: object = {}) => ({
    lines: [{ unitCents: 1428 }, { unitCents: 500 }], subtotalCents: 1928, discountCents: 193, taxCents: 113, totalCents: 1848,
    tip: { mode: 'none', cents: 0, needsConfirmation: false }, ...over,
  });
  const lines = [{ size: 'large', quantity: 1, toppings: new Set(['pepperoni', 'bacon']) }, { size: 'small', quantity: 1, toppings: new Set() }];

  it('claims exactly the figures from the quote the customer has seen', () => {
    expect(claimFromQuote(quote())).toEqual({
      lines: [{ unitCents: 1428 }, { unitCents: 500 }], subtotalCents: 1928, discountCents: 193, taxCents: 113, tipCents: 0, totalCents: 1848,
    });
  });

  it('sends the order, the claim and the menu session, with toppings as plain lists', () => {
    const body = buildPlaceRequest({ menuToken: 'tok', lines, tip: { mode: 'none' }, promoCodes: ['ILOVEPIZZA'], quote: quote() });
    expect(body).toEqual({
      menuToken: 'tok',
      order: {
        lines: [{ size: 'large', quantity: 1, toppings: ['pepperoni', 'bacon'] }, { size: 'small', quantity: 1, toppings: [] }],
        tip: { mode: 'none' },
        promoCodes: ['ILOVEPIZZA'],
      },
      claimed: claimFromQuote(quote()),
    });
  });

  it('confirms a very large tip, by amount, only when the quote flagged one', () => {
    const plain = buildPlaceRequest({ menuToken: 't', lines, tip: { mode: 'none' }, promoCodes: [], quote: quote() });
    expect(plain).not.toHaveProperty('confirmations');

    const big = quote({ tip: { mode: 'amount', cents: 3000, needsConfirmation: true } });
    const body = buildPlaceRequest({ menuToken: 't', lines, tip: { mode: 'amount', cents: 3000 }, promoCodes: [], quote: big });
    expect(body.confirmations).toEqual({ largeTipCents: 3000 });
    expect(body.claimed.tipCents).toBe(3000);
  });
});

describe('describeHold: what to tell the customer when the service holds the order', () => {
  const held = (over: object = {}) => ({
    error: 'confirmation_required',
    message: 'Please review and confirm before we place your order',
    reasons: ['prices_changed'],
    differences: [{ field: 'total', message: 'Total: you were shown $10.00, but it is $13.69' }],
    removedPromos: [],
    quote: { promos: [], totalCents: 1369, taxableCents: 1285, taxCents: 84, tip: { mode: 'none', cents: 0, needsConfirmation: false } },
    ...over,
  });

  it('a changed price: says what differs and ends with the new total', () => {
    const r = describeHold(held(), { appliedBefore: [] });
    expect(r.notices).toEqual(['Total: you were shown $10.00, but it is $13.69.', 'Your new total is $13.69.']);
    expect(r.needsConfirm).toBe(true);
  });

  it('a promo the service dropped: named, with its reason, even if the page did not know it was applied', () => {
    const data = held({
      reasons: ['prices_changed', 'promo_removed'],
      removedPromos: ['SAVE5'],
      differences: [{ field: 'discount', message: 'Discount: you were shown $5.00, but it is $0.00' }, { field: 'total', message: 'Total: x' }],
      quote: { promos: [{ code: 'SAVE5', applied: false, message: 'SAVE5 needs an order over $20.00 before tax' }], totalCents: 2663, taxableCents: 2500, taxCents: 163, tip: { mode: 'none', cents: 0, needsConfirmation: false } },
    });
    const r = describeHold(data, { appliedBefore: [] });
    expect(r.removedCodes).toEqual(['SAVE5']);
    expect(r.appliedCodes).toEqual([]); // so the code is cleared from the promo box
    expect(r.notices).toEqual(['SAVE5 no longer applies: SAVE5 needs an order over $20.00 before tax.', 'Your new total is $26.63.']);
  });

  it('a large tip that was not confirmed', () => {
    const data = held({
      reasons: ['large_tip'],
      differences: [],
      quote: { promos: [], totalCents: 8112, taxableCents: 4800, taxCents: 312, tip: { mode: 'amount', cents: 3000, needsConfirmation: true } },
    });
    const r = describeHold(data, { appliedBefore: [] });
    expect(r.bigTip).toBe(true);
    expect(r.notices).toEqual(['Your tip of $30.00 is half your bill or more (your bill is $51.12 before the tip). Please make sure that is what you intend.']);
  });

  it('never leaves the customer with an empty explanation', () => {
    const r = describeHold(held({ differences: [] }), { appliedBefore: [] });
    expect(r.notices).toEqual(['Please review and confirm before we place your order. Your total is $13.69.']);
  });
});

describe('newIdempotencyKey', () => {
  const ACCEPTED_BY_THE_SERVICE = /^[A-Za-z0-9_-]{8,100}$/; // the same rule the service enforces

  it('produces a key the service accepts', () => {
    expect(newIdempotencyKey()).toMatch(ACCEPTED_BY_THE_SERVICE);
  });

  it('is different every time', () => {
    const keys = new Set(Array.from({ length: 200 }, () => newIdempotencyKey()));
    expect(keys.size).toBe(200);
  });

  it('uses the browser\'s secure randomness when it has it', () => {
    const fake = { getRandomValues: (a: Uint8Array) => (a.fill(255), a) };
    expect(newIdempotencyKey(fake)).toBe('ord-' + 'ff'.repeat(16));
  });

  it('still works where secure randomness is unavailable', () => {
    expect(newIdempotencyKey(null)).toMatch(ACCEPTED_BY_THE_SERVICE);
    expect(newIdempotencyKey({})).toMatch(ACCEPTED_BY_THE_SERVICE);
  });
});

describe('editing: putting a saved order back in the form', () => {
  it.each([
    [{ mode: 'none', input: 0 }, { mode: 'none', text: '' }],
    [{ mode: 'amount', input: 500 }, { mode: 'amount', text: '5.00' }],
    [{ mode: 'amount', input: 550 }, { mode: 'amount', text: '5.50' }],
    [{ mode: 'amount', input: 5 }, { mode: 'amount', text: '0.05' }],
    [{ mode: 'percent', input: 1800 }, { mode: 'percent', text: '18' }],
    [{ mode: 'percent', input: 1850 }, { mode: 'percent', text: '18.5' }],
    [{ mode: 'percent', input: 1825 }, { mode: 'percent', text: '18.25' }],
    [{ mode: 'percent', input: 5 }, { mode: 'percent', text: '0.05' }],
    [undefined, { mode: 'none', text: '' }],
  ])('the tip %j goes back into the box as %j', (tip, expected) => {
    expect(tipInputsFromOrder(tip)).toEqual(expected);
  });

  it('and what comes out of the box is the same tip that went in (a round trip)', () => {
    for (const tip of [{ mode: 'amount', input: 1234 }, { mode: 'percent', input: 1999 }, { mode: 'percent', input: 100 }, { mode: 'amount', input: 7 }]) {
      const box = tipInputsFromOrder(tip);
      const back = tipFromInput(box.mode, box.text);
      expect(back.ok).toBe(true);
      expect(back.tip[tip.mode === 'amount' ? 'cents' : 'bps']).toBe(tip.input);
    }
  });

  const menu = { sizes: [{ code: 'small' }, { code: 'large' }], toppings: [{ code: 'bacon' }, { code: 'pepperoni' }] };
  const saved = (lines: object[]) => ({ lines });
  const L = (size: string, label: string, quantity: number, toppings: [string, string][]) => ({
    size: { code: size, label }, quantity, toppings: toppings.map(([code, l]) => ({ code, label: l })),
  });

  it('rebuilds the pizzas as codes, ready to edit', () => {
    const r = linesFromOrder(saved([L('large', 'Large', 2, [['bacon', 'Bacon']])]), menu);
    expect(r.dropped).toEqual([]);
    expect(r.lines).toEqual([{ size: 'large', quantity: 2, toppings: new Set(['bacon']) }]);
  });

  it('drops what is no longer sold and says so', () => {
    const r = linesFromOrder(
      saved([L('medium', 'Medium', 3, [['bacon', 'Bacon']]), L('small', 'Small', 1, [['bacon', 'Bacon'], ['pineapple', 'Pineapple']])]),
      menu,
    );
    expect(r.lines).toEqual([{ size: 'small', quantity: 1, toppings: new Set(['bacon']) }]);
    expect(r.dropped).toEqual(['3 × Medium pizza', 'Pineapple topping']);
  });
});

describe('editing: how a change compares with the order as it stands', () => {
  const current = { subtotalCents: 500, discountCents: 0, taxCents: 33, tip: { cents: 0 }, totalCents: 533 };
  const quote = (over: object) => ({ subtotalCents: 2664, discountCents: 266, taxCents: 156, tip: { cents: 300 }, totalCents: 2854, ...over });

  it.each([
    [0, 'The same price as your current order'],
    [138, '$1.38 more than your current order'],
    [-200, '$2.00 less than your current order'],
    [5, '$0.05 more than your current order'],
  ])('a change of %i cents reads: %s', (delta, text) => expect(describeDelta(delta)).toBe(text));

  it('lists every part of the bill, what it was, what it is, and the effect on what you pay', () => {
    const r = compareToCurrent(current, quote({}));
    expect(r.rows).toEqual([
      { label: 'Subtotal', was: 500, now: 2664, effect: 2164 },
      { label: 'Promo discount', was: 0, now: 266, effect: -266 }, // a bigger discount lowers the price
      { label: 'Tax', was: 33, now: 156, effect: 123 },
      { label: 'Tip', was: 0, now: 300, effect: 300 },
      { label: 'Total', was: 533, now: 2854, effect: 2321 },
    ]);
    expect(r.totalDelta).toBe(2321);
    expect(r.text).toBe('$23.21 more than your current order');
  });

  it('the effects of the parts always add up to the effect on the total', () => {
    for (const q of [quote({}), quote({ discountCents: 0, totalCents: 3120 }), quote({ subtotalCents: 100, discountCents: 0, taxCents: 7, tip: { cents: 0 }, totalCents: 107 })]) {
      const r = compareToCurrent(current, q);
      const parts = r.rows.filter((x: { label: string }) => x.label !== 'Total').reduce((s: number, x: { effect: number }) => s + x.effect, 0);
      // (only holds when the quote itself adds up, which the service guarantees)
      if (q.totalCents === q.subtotalCents - q.discountCents + q.taxCents + q.tip.cents) expect(parts).toBe(r.totalDelta);
    }
  });

  it('says so when nothing changes', () => {
    const same = compareToCurrent(current, { subtotalCents: 500, discountCents: 0, taxCents: 33, tip: { cents: 0 }, totalCents: 533 });
    expect(same.text).toBe('The same price as your current order');
    expect(same.rows.every((r: { effect: number }) => r.effect === 0)).toBe(true);
  });

  it('says so when it gets cheaper', () => {
    const cheaper = compareToCurrent({ ...current, subtotalCents: 2000, taxCents: 130, totalCents: 2130 }, quote({ subtotalCents: 500, discountCents: 0, taxCents: 33, tip: { cents: 0 }, totalCents: 533 }));
    expect(cheaper.text).toBe('$15.97 less than your current order');
  });
});

describe('editing: the order moves on while the customer is changing it', () => {
  const order = (over: object = {}) => ({ status: 'NOT_STARTED', canEdit: true, version: 3, ...over });

  it('a customer who can carry on is left alone', () => {
    expect(watchVerdict(order(), { version: 3 })).toEqual({ verdict: 'ok' });
  });

  it.each([
    ['STARTED', 'The kitchen has already started your order, so it can no longer be changed.'],
    ['READY_FOR_PICKUP', 'Your order is ready for pickup, so it can no longer be changed.'],
    ['DELIVERED', 'Your order has already been delivered, so it can no longer be changed.'],
    ['CANCELLED', 'This order has been cancelled, so it can no longer be changed.'],
  ])('once the status is %s the edit is locked, with a message to show them', (status, message) => {
    expect(watchVerdict(order({ status, canEdit: false, version: 4 }), { version: 3 })).toEqual({ verdict: 'locked', message });
    expect(lockedMessage(status)).toBe(message);
  });

  it('is locked even if the server\'s canEdit flag were missing: the status alone decides', () => {
    expect(watchVerdict({ status: 'STARTED', version: 3 }, { version: 3 }).verdict).toBe('locked');
  });

  it('locked takes priority over "changed" (the status moved, and so the version did too)', () => {
    expect(watchVerdict(order({ status: 'STARTED', canEdit: false, version: 9 }), { version: 3 }).verdict).toBe('locked');
  });

  it('a new version while still Not Started means it was changed elsewhere', () => {
    const r = watchVerdict(order({ version: 4 }), { version: 3 });
    expect(r.verdict).toBe('changed');
    expect(r.message).toMatch(/changed somewhere else/);
  });

  it('an order that could not be read is not a reason to raise an alarm', () => {
    expect(watchVerdict(null, { version: 3 })).toEqual({ verdict: 'ok' });
  });
});

describe('debounce: a burst of changes fires once, with the last one', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('does nothing until the changes stop, then runs once', () => {
    const fn = vi.fn();
    const d = debounce(fn, 450);
    d();
    vi.advanceTimersByTime(449);
    expect(fn).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('a rapid burst fires ONCE, after the last change, with the last arguments', () => {
    const fn = vi.fn();
    const d = debounce(fn, 450);
    for (const n of [1, 2, 3, 4, 5]) {
      d(n);
      vi.advanceTimersByTime(100); // each change arrives before the previous wait is over
    }
    expect(fn).not.toHaveBeenCalled();
    vi.advanceTimersByTime(450);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledWith(5);
  });

  it('every change restarts the wait', () => {
    const fn = vi.fn();
    const d = debounce(fn, 450);
    d();
    vi.advanceTimersByTime(400);
    d(); // restarts: the first run is no longer due at 450
    vi.advanceTimersByTime(400);
    expect(fn).not.toHaveBeenCalled();
    vi.advanceTimersByTime(50);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('two bursts with a pause between them fire twice, once each', () => {
    const fn = vi.fn();
    const d = debounce(fn, 450);
    d('a');
    d('b');
    vi.advanceTimersByTime(450);
    d('c');
    d('d');
    vi.advanceTimersByTime(450);
    expect(fn.mock.calls).toEqual([['b'], ['d']]);
  });

  it('cancel drops a run that is waiting, and says whether one is', () => {
    const fn = vi.fn();
    const d = debounce(fn, 450);
    expect(d.pending()).toBe(false);
    d();
    expect(d.pending()).toBe(true);
    d.cancel();
    expect(d.pending()).toBe(false);
    vi.advanceTimersByTime(1000);
    expect(fn).not.toHaveBeenCalled();
  });

  it('is no longer pending once it has run, and can be used again', () => {
    const fn = vi.fn();
    const d = debounce(fn, 450);
    d();
    vi.advanceTimersByTime(450);
    expect(d.pending()).toBe(false);
    d();
    vi.advanceTimersByTime(450);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('uses the real timers by default, called as plain functions (a browser refuses them as methods)', () => {
    const fn = vi.fn();
    const d = debounce(fn, 10); // no timers passed: the default wrappers
    d();
    vi.advanceTimersByTime(10);
    expect(fn).toHaveBeenCalledTimes(1);
  });
});

describe('latestOnly: when answers overlap, only the newest is used', () => {
  it('the newest ticket is the latest; an older one is not', () => {
    const latest = latestOnly();
    const first = latest.next();
    expect(latest.isLatest(first)).toBe(true);
    const second = latest.next();
    expect(latest.isLatest(first)).toBe(false);
    expect(latest.isLatest(second)).toBe(true);
  });

  it('answers that arrive out of order: the slow older one is ignored, the newer one is kept', () => {
    const latest = latestOnly();
    const shown: string[] = [];
    const answer = (ticket: number, text: string) => { if (latest.isLatest(ticket)) shown.push(text); };

    const older = latest.next(); // request 1 sent
    const newer = latest.next(); // request 2 sent, because the customer changed something
    answer(newer, 'newer'); // request 2 comes back first
    answer(older, 'older'); // request 1 limps in later and must not overwrite it
    expect(shown).toEqual(['newer']);
  });

  it('invalidate makes every request still in flight out of date (the order changed again)', () => {
    const latest = latestOnly();
    const inFlight = latest.next();
    latest.invalidate();
    expect(latest.isLatest(inFlight)).toBe(false);
    expect(latest.isLatest(latest.next())).toBe(true); // and the next request starts fresh
  });
});

describe('when the order can be placed', () => {
  it.each([
    [STATUS.STALE, false], [STATUS.CHECKING, false], [STATUS.READY, true], [STATUS.NEEDS_CONFIRM, false],
    [STATUS.CONFIRMED, true], [STATUS.EXPIRED, false], [STATUS.ERROR, false], [STATUS.LOCKED, false],
  ])('%s -> can place: %s', (status, can) => {
    expect(canPlaceOrder(status)).toBe(can);
    expect(whyNotPlaceable(status) === null).toBe(can); // a reason is given exactly when it is disabled
  });

  it('only checked-and-clear or confirmed orders can be placed; nothing else', () => {
    expect(Object.values(STATUS).filter(canPlaceOrder).sort()).toEqual(['confirmed', 'ready']);
  });

  it('an unknown status is treated as "not checked", never as placeable', () => {
    expect(canPlaceOrder('something-new')).toBe(false);
    expect(whyNotPlaceable('something-new')).toBe('Check your total before placing the order.');
  });
});

describe('the session countdown', () => {
  const t = (iso: string) => Date.parse(iso);
  const loaded = { expiresAt: '2026-06-15T12:30:00.000Z', serverTime: '2026-06-15T12:00:00.000Z', loadedAtMs: 1_000_000 };

  it('starts at the full window and counts down with the device clock', () => {
    expect(secondsLeft({ ...loaded, nowMs: 1_000_000 })).toBe(1800);
    expect(secondsLeft({ ...loaded, nowMs: 1_000_000 + 60_000 })).toBe(1740);
    expect(secondsLeft({ ...loaded, nowMs: 1_000_000 + 1_800_000 })).toBe(0);
  });

  it('is not fooled by a device clock that is wrong: only elapsed time matters', () => {
    // The device thinks it is 1970; the server's clock is what the deadline is measured on.
    expect(secondsLeft({ ...loaded, loadedAtMs: 5, nowMs: 5 + 120_000 })).toBe(1680);
    expect(t(loaded.serverTime)).toBeGreaterThan(1_000_000);
  });

  it('never goes below zero, and rounds up so it does not show 0:00 early', () => {
    expect(secondsLeft({ ...loaded, nowMs: 1_000_000 + 99_999_999 })).toBe(0);
    expect(secondsLeft({ ...loaded, nowMs: 1_000_000 + 1_799_001 })).toBe(1);
  });

  it.each([[1800, '30:00'], [65, '1:05'], [59, '0:59'], [0, '0:00'], [-3, '0:00'], [3599, '59:59']])('%i seconds -> %s', (s, text) => {
    expect(formatCountdown(s)).toBe(text);
  });
});

describe('carryOver: keeping the order when the session is renewed', () => {
  const menu = { sizes: [{ code: 'small' }, { code: 'large' }], toppings: [{ code: 'bacon' }, { code: 'pepperoni' }] };

  it('keeps everything still on the menu', () => {
    const lines = [{ id: 1, size: 'large', quantity: 2, toppings: new Set(['bacon']) }];
    const r = carryOver(lines, menu);
    expect(r.dropped).toEqual([]);
    expect(r.lines[0]).toMatchObject({ id: 1, size: 'large', quantity: 2 });
    expect([...r.lines[0].toppings]).toEqual(['bacon']);
  });

  it('drops a pizza whose size is gone and a topping that is gone, and says so', () => {
    const lines = [
      { id: 1, size: 'medium', quantity: 3, toppings: new Set(['bacon']) },
      { id: 2, size: 'small', quantity: 1, toppings: new Set(['bacon', 'pineapple']) },
    ];
    const r = carryOver(lines, menu);
    expect(r.lines.map((l: { id: number }) => l.id)).toEqual([2]);
    expect([...r.lines[0].toppings]).toEqual(['bacon']);
    expect(r.dropped).toEqual(['3 × medium pizza', 'pineapple topping']);
  });

  it('does not change the lines it was given', () => {
    const lines = [{ id: 1, size: 'small', quantity: 1, toppings: new Set(['pineapple']) }];
    carryOver(lines, menu);
    expect([...lines[0]!.toppings]).toEqual(['pineapple']);
  });
});

describe('money', () => {
  it.each([[0, '$0.00'], [5, '$0.05'], [2130, '$21.30'], [-500, '-$5.00']])('%i -> %s', (c, s) => expect(money(c)).toBe(s));
});

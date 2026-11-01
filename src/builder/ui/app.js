// Order builder page: wiring only. Every decision (is the tip valid? what changed? can the order
// be placed? how long is left?) is made in logic.js, which has its own tests.
//
// The menu is fetched once. Editing the order re-prices the preview in the browser. The
// authoritative figures (tax, promos, total) come from the order service when the customer
// presses "Check my total" or "Apply", and the order can only be placed once the service has
// checked it and the customer has seen and accepted anything that changed.
// All server-supplied text is inserted with textContent, never as HTML.

import {
  STATUS, money, tipFromInput, codesFromInput, buildQuoteRequest, interpretQuote,
  buildPlaceRequest, describeHold, newIdempotencyKey,
  tipInputsFromOrder, linesFromOrder, compareToCurrent, watchVerdict, lockedMessage,
  canPlaceOrder, whyNotPlaceable, secondsLeft, formatCountdown, carryOver,
} from '/logic.js';

const MAX_QTY = 100;
const REQUEST_TIMEOUT_MS = 15_000;
const WATCH_MS = 3000; // how often an order being changed is checked to see whether it has moved on
const SOON_SECONDS = 300;
const $ = (id) => document.getElementById(id);

// Opened as /change/<order id> from the status page, this page changes an existing order instead of
// placing a new one; at / it builds a new order.
const editId = (() => {
  const m = location.pathname.match(/^\/change\/([^/]+)/);
  return m ? decodeURIComponent(m[1]) : null;
})();

// ------------------------------------------------------------------- state ---

let menu = null; // the menu response: prices, menuToken, expiresAt, serverTime
let loadedAtMs = 0; // device time when the menu arrived, for the countdown
let status = STATUS.STALE;
let last = null; // { quote, appliedCodes }: the last quote from the service
let promoCodes = []; // codes currently applied (shown as chips)
let notices = []; // information for the customer about what changed
let acceptLabel = 'Accept updated total'; // what the confirm button says for the current notices
let pendingKey = null; // identifies the current attempt to place the order, so a retry cannot place it twice
let editing = null; // when changing an order: { id, version, current: the order as it stands, originalTotal, appliedCodes }
let watchTimer; // polls the order being changed to see whether it can still be changed
let nextId = 1;
const lines = []; // { id, size, quantity, toppings: Set<code>, ui }

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else if (k === 'class') node.className = v;
    else node[k] = v;
  }
  node.append(...children);
  return node;
}

function showError(message) {
  $('error').hidden = !message;
  $('error').textContent = message ?? '';
}

// -------------------------------------------------- busy: block everything ---
// While a request is running the whole page is inert and a spinner shows. The spinner only
// appears if the request takes more than a moment, so quick answers don't flash.

let busyCount = 0;
let busyTimer;
let refocus = null;

function beginBusy(label) {
  if (busyCount++ === 0) refocus = document.activeElement;
  $('busyLabel').textContent = label;
  $('page').inert = true;
  clearTimeout(busyTimer);
  busyTimer = setTimeout(() => { if (busyCount > 0 && !$('busy').open) $('busy').showModal(); }, 150);
}

function endBusy() {
  busyCount = Math.max(0, busyCount - 1);
  if (busyCount > 0) return;
  clearTimeout(busyTimer);
  if ($('busy').open) $('busy').close();
  $('page').inert = false;
  if (refocus && refocus.isConnected && !refocus.disabled) refocus.focus();
}

// The busy dialog cannot be dismissed with Escape.
$('busy').addEventListener('cancel', (e) => e.preventDefault());
$('timeout').addEventListener('cancel', (e) => e.preventDefault());

async function postJson(path, body, extraHeaders = {}, method = 'POST') {
  const res = await fetch(path, {
    method,
    headers: { 'content-type': 'application/json', ...extraHeaders },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  return { status: res.status, ok: res.ok, data: await res.json().catch(() => ({})) };
}

const networkMessage = (err) =>
  err && err.name === 'TimeoutError'
    ? 'That took too long. Please try again.'
    : 'We could not reach the restaurant. Check your connection and try again.';

// ----------------------------------------------------------------- pricing ---
// The preview only ADDS whole cents the service has already worked out per size.

const sizePrice = (code) => menu.sizes.find((s) => s.code === code).priceCents;

function unitPrice(line) {
  let cents = sizePrice(line.size);
  for (const t of menu.toppings) if (line.toppings.has(t.code)) cents += t.pricesCents[line.size];
  return cents;
}
const lineTotal = (line) => unitPrice(line) * line.quantity;
const previewSubtotal = () => lines.reduce((sum, l) => sum + lineTotal(l), 0);

// -------------------------------------------------------------- menu tables ---

function ruleText(price) {
  return price.type === 'static' ? `${money(price.amount)} flat` : `${price.amount / 100}% of pizza price`;
}

function renderMenu() {
  $('menuInfo').textContent = `${menu.menu.name} · ${menu.sizes.length} sizes · ${menu.toppings.length} toppings`;

  $('sizeTable').replaceChildren(
    el('thead', {}, el('tr', {}, el('th', {}, 'Pizza'), el('th', {}, 'Price'))),
    el('tbody', {}, ...menu.sizes.map((s) => el('tr', {}, el('td', {}, s.label), el('td', {}, money(s.priceCents))))),
  );

  const rows = [];
  let lastCategory;
  for (const t of menu.toppings) {
    const category = t.category?.label ?? 'Other';
    if (category !== lastCategory) {
      rows.push(el('tr', { class: 'cat' }, el('th', { colSpan: menu.sizes.length + 2 }, category)));
      lastCategory = category;
    }
    rows.push(el('tr', {}, el('td', {}, t.label), el('td', { class: 'rule' }, ruleText(t.price)), ...menu.sizes.map((s) => el('td', {}, money(t.pricesCents[s.code])))));
  }
  $('toppingTable').replaceChildren(
    el('thead', {}, el('tr', {}, el('th', {}, 'Topping'), el('th', {}, 'Rule'), ...menu.sizes.map((s) => el('th', {}, s.label)))),
    el('tbody', {}, ...rows),
  );
}

// ------------------------------------------------------------- order lines ---

function toppingGroups() {
  const groups = new Map();
  for (const t of menu.toppings) {
    const key = t.category?.label ?? 'Other';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(t);
  }
  return groups;
}

function buildLine(line) {
  const priceByTopping = new Map();

  const sizeSelect = el(
    'select',
    { id: `size-${line.id}`, onchange: () => { line.size = sizeSelect.value; refresh(); edited(); } },
    ...menu.sizes.map((s) => el('option', { value: s.code }, `${s.label} — ${money(s.priceCents)}`)),
  );
  sizeSelect.value = line.size;

  const qty = el('input', { id: `qty-${line.id}`, type: 'number', min: 1, max: MAX_QTY, step: 1, value: line.quantity });
  qty.addEventListener('input', () => {
    const n = Number(qty.value);
    if (Number.isInteger(n) && n >= 1 && n <= MAX_QTY) { line.quantity = n; refresh(); edited(); }
  });
  qty.addEventListener('change', () => { qty.value = line.quantity; }); // snap back to the last valid quantity

  const totalEl = el('span', { class: 'big' });
  const eachEl = el('span', { class: 'small' });
  const removeBtn = el('button', { type: 'button', class: 'danger', onclick: () => removeLine(line) }, 'Remove');

  const node = el(
    'div',
    { class: 'line' },
    el(
      'div',
      { class: 'line-head' },
      el('label', { class: 'f' }, 'Pizza', sizeSelect),
      el('label', { class: 'f' }, 'Quantity', qty),
      el('div', { class: 'line-price' }, totalEl, eachEl),
      removeBtn,
    ),
  );
  for (const [category, toppings] of toppingGroups()) {
    const box = el('div', { class: 'toppings' });
    for (const t of toppings) {
      const check = el('input', { type: 'checkbox', checked: line.toppings.has(t.code) });
      check.addEventListener('change', () => {
        if (check.checked) line.toppings.add(t.code); else line.toppings.delete(t.code);
        refresh();
        edited();
      });
      const price = el('span', { class: 'p' });
      priceByTopping.set(t.code, price);
      box.append(el('label', {}, check, t.label, price));
    }
    node.append(el('fieldset', {}, el('legend', {}, category), box)); // the category's name already says "toppings"
  }

  // Text is updated in place, never rebuilt, so keyboard focus survives every change.
  function refresh() {
    for (const t of menu.toppings) priceByTopping.get(t.code).textContent = `+${money(t.pricesCents[line.size])}`;
    totalEl.textContent = money(lineTotal(line));
    eachEl.textContent = `${money(unitPrice(line))} each × ${line.quantity}`;
  }

  line.ui = { node, refresh, removeBtn };
  refresh();
  return node;
}

function addLine() {
  const line = { id: nextId++, size: menu.sizes[0].code, quantity: 1, toppings: new Set() };
  lines.push(line);
  $('lines').append(buildLine(line));
  syncRemoveButtons();
}

function removeLine(line) {
  if (lines.length <= 1) return; // an order always has at least one pizza
  lines.splice(lines.indexOf(line), 1);
  line.ui.node.remove();
  syncRemoveButtons();
  edited();
}

function syncRemoveButtons() {
  for (const l of lines) l.ui.removeBtn.disabled = lines.length <= 1;
}

// ----------------------------------------------------- edits mark it stale ---

/** The order, tip or promos changed: whatever was checked no longer describes the order. */
function edited() {
  if (status === STATUS.EXPIRED || status === STATUS.LOCKED) return;
  status = STATUS.STALE;
  notices = [];
  pendingKey = null; // a changed order is a new attempt
  $('promoMsg').textContent = '';
  renderSummary();
}

// ------------------------------------------------------------------ render ---

function renderSummary() {
  // Promo chips: the codes currently applied, with what each took off.
  $('promoChips').replaceChildren(
    ...promoCodes.map((code) => {
      const outcome = last?.quote.promos.find((p) => p.code === code && p.applied);
      return el(
        'span',
        { class: 'chip' },
        outcome ? `${code} −${money(outcome.discountCents)}` : code,
        el('button', { type: 'button', ariaLabel: `Remove ${code}`, onclick: () => removePromo(code) }, '✕'),
      );
    }),
  );

  // What changed, held until the customer accepts it.
  const notice = $('notice');
  notice.hidden = notices.length === 0;
  notice.replaceChildren();
  if (notices.length) {
    notice.append(el('ul', {}, ...notices.map((n) => el('li', {}, n))));
    if (status === STATUS.NEEDS_CONFIRM) notice.append(el('button', { id: 'accept', type: 'button', class: 'primary', onclick: accept }, acceptLabel));
  }

  // The service's figures, dimmed once the order has changed since.
  const summary = $('summary');
  summary.className = status === STATUS.STALE || status === STATUS.EXPIRED ? 'stale' : '';
  summary.replaceChildren(el('p', { class: 'hint' }, `Pizzas and toppings so far: ${money(previewSubtotal())}`));
  if (last) {
    const q = last.quote;
    const rows = [['Subtotal', money(q.subtotalCents)]];
    for (const p of q.promos.filter((x) => x.applied)) rows.push([`Promo ${p.code}`, `−${money(p.discountCents)}`]);
    rows.push([`Tax (${q.taxRateBps / 100}%)`, money(q.taxCents)]);
    if (q.tip.mode !== 'none') rows.push(['Tip', money(q.tip.cents)]);
    const dl = el('dl', {});
    for (const [k, v] of rows) dl.append(el('dt', {}, k), el('dd', {}, v));
    dl.append(el('dt', { class: 'total' }, 'Total'), el('dd', { class: 'total' }, money(q.totalCents)));
    if (status === STATUS.STALE || status === STATUS.EXPIRED) summary.append(el('p', { class: 'stalenote' }, 'Out of date: check your total again.'));
    summary.append(dl);
    if (q.withoutPromo) {
      const saved = q.withoutPromo.totalCents - q.totalCents;
      summary.append(el('p', { class: 'without' }, `Without the promo your total would be ${money(q.withoutPromo.totalCents)}. `, el('span', { class: 'save' }, `You save ${money(saved)}.`)));
    }
    if (editing) summary.append(compareTable(q));
  }

  $('placeBtn').textContent = editing ? 'Save changes' : 'Place order';
  $('placeBtn').disabled = !canPlaceOrder(status);
  $('placeHint').textContent = whyNotPlaceable(status) ?? (editing ? 'Ready to save your changes.' : 'Ready to place your order.');
}

/** When changing an order: how the updated order compares with the order as it stands, part by part. */
function compareTable(quote) {
  const cmp = compareToCurrent(editing.current, quote);
  const effect = (cents) => (cents === 0 ? '—' : `${cents > 0 ? '+' : '−'}${money(Math.abs(cents))}`);
  const table = el(
    'table',
    {},
    el('thead', {}, el('tr', {}, el('th', {}, ''), el('th', {}, 'Your order now'), el('th', {}, 'As updated'), el('th', {}, 'Change'))),
    el(
      'tbody',
      {},
      ...cmp.rows.map((r) =>
        el('tr', {}, el('td', {}, r.label), el('td', {}, money(r.was)), el('td', {}, money(r.now)), el('td', { class: `effect ${r.effect > 0 ? 'up' : r.effect < 0 ? 'down' : ''}` }, effect(r.effect))),
      ),
    ),
  );
  const box = el('div', { id: 'compare' }, el('h3', {}, 'Compared with your order as it stands'), el('div', { class: 'tablewrap' }, table), el('p', { class: 'delta' }, cmp.text));
  if (editing.originalTotal !== null && editing.originalTotal !== editing.current.totalCents) {
    box.append(el('p', { class: 'hint' }, `It was first placed at ${money(editing.originalTotal)}.`));
  }
  return box;
}

// ----------------------------------------------------------- tip and promos ---

$('tipMode').addEventListener('change', () => {
  const mode = $('tipMode').value;
  $('tipValueWrap').hidden = mode === 'none';
  $('tipValueLabel').textContent = mode === 'percent' ? 'Percent' : 'Dollars';
  $('tipValue').placeholder = mode === 'percent' ? '18' : '5.00';
  $('tipMsg').textContent = '';
  edited();
});
$('tipValue').addEventListener('input', () => { $('tipMsg').textContent = ''; edited(); });
$('promoInput').addEventListener('input', () => edited());
$('promoInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); applyPromo(); } });

function removePromo(code) {
  promoCodes = promoCodes.filter((c) => c !== code);
  if (last) last = { ...last, appliedCodes: last.appliedCodes.filter((c) => c !== code) }; // removed on purpose, not by the service
  edited();
}

function applyPromo() {
  if (codesFromInput($('promoInput').value).length === 0) {
    $('promoMsg').textContent = 'Enter a promo code first.';
    return;
  }
  check('Applying your promo code…');
}

// ------------------------------------------------------------------- quote ---

async function check(label = 'Checking your total…') {
  const tip = tipFromInput($('tipMode').value, $('tipValue').value);
  $('tipMsg').textContent = tip.ok ? '' : tip.message;
  if (!tip.ok) return;

  // Codes already applied plus any just typed; typed ones are moved out of the box now.
  promoCodes = [...new Set([...promoCodes, ...codesFromInput($('promoInput').value)])];
  $('promoInput').value = '';
  $('promoMsg').textContent = '';

  // Figures are only claimed if they are what the customer is looking at (not dimmed).
  const figuresShown = last && status !== STATUS.STALE && status !== STATUS.EXPIRED;
  const request = buildQuoteRequest({
    menuToken: menu.menuToken,
    lines,
    tip: tip.tip,
    promoCodes,
    shown: {
      lines: lines.map(unitPrice),
      subtotal: previewSubtotal(),
      figures: figuresShown
        ? { discountCents: last.quote.discountCents, taxCents: last.quote.taxCents, tipCents: last.quote.tip.cents, totalCents: last.quote.totalCents }
        : null,
    },
  });
  // The codes the customer was last looking at as applied (when changing an order: the ones it already has).
  const appliedBefore = last ? last.appliedCodes : editing ? editing.appliedCodes : [];

  status = STATUS.CHECKING;
  renderSummary();
  beginBusy(label);
  try {
    const res = await postJson('/api/quote', request);
    if (status === STATUS.EXPIRED) return; // the session ended while we waited; the dialog is already up

    if (res.ok) {
      const result = interpretQuote(res.data, { appliedBefore });
      last = { quote: res.data.quote, appliedCodes: result.appliedCodes };
      promoCodes = result.appliedCodes; // a refused code is removed from the box
      notices = result.notices;
      acceptLabel = result.acceptLabel;
      $('promoMsg').textContent = result.rejectedNew.map((r) => r.message).join(' ');
      status = result.needsConfirm ? STATUS.NEEDS_CONFIRM : STATUS.READY;
      showError(null);
    } else if (res.status === 409 && ['menu_expired', 'menu_unknown'].includes(res.data.error)) {
      expire(res.data.message);
    } else if (res.status === 422) {
      status = STATUS.ERROR;
      notices = (res.data.issues ?? []).map((i) => i.message);
      if (notices.length === 0) notices = [res.data.message ?? 'Please check your order.'];
    } else {
      status = STATUS.ERROR;
      notices = [res.data.message ?? 'Something went wrong. Please try again.'];
    }
  } catch (err) {
    status = STATUS.ERROR;
    notices = [networkMessage(err)];
  } finally {
    endBusy();
    renderSummary();
    $('accept')?.focus(); // draw a keyboard user to what needs their attention
  }
}

function accept() {
  status = STATUS.CONFIRMED;
  notices = [];
  renderSummary();
}

$('checkBtn').addEventListener('click', () => check());
$('applyPromo').addEventListener('click', applyPromo);
$('addLine').addEventListener('click', () => { addLine(); edited(); });
$('placeBtn').addEventListener('click', placeOrder);

// ------------------------------------------------------------ placing the order ---

/** Show the confirm dialog and wait for the customer: 'ok' (accept the updated figures and place the order) or 'cancel'. */
function askConfirm(items, totalCents) {
  $('confirmList').replaceChildren(...items.map((text) => el('li', {}, text)));
  $('confirmTotal').textContent = `Total: ${money(totalCents)}`;
  const dialog = $('confirm');
  return new Promise((resolve) => {
    const finish = (choice) => () => { dialog.close(); resolve(choice); };
    $('confirmOk').onclick = finish('ok');
    $('confirmCancel').onclick = finish('cancel');
    dialog.oncancel = (e) => { e.preventDefault(); finish('cancel')(); }; // Escape means Cancel
    dialog.showModal();
    $('confirmOk').focus();
  });
}

async function placeOrder() {
  if (!canPlaceOrder(status) || !last) return;
  const tip = tipFromInput($('tipMode').value, $('tipValue').value);
  if (!tip.ok) { $('tipMsg').textContent = tip.message; return; }

  pendingKey ??= newIdempotencyKey();
  let quote = last.quote; // the figures the customer has seen and accepted
  let appliedBefore = last.appliedCodes;
  let holds = 0;

  // Changing an order sends the version being changed; the service applies it only to that version,
  // and only while the order has not been started.
  const verb = editing ? 'saved' : 'placed';

  for (;;) {
    beginBusy(editing ? 'Saving your changes…' : 'Placing your order…');
    let res;
    try {
      res = await postJson(
        editing ? `/api/orders/${encodeURIComponent(editing.id)}` : '/api/orders',
        {
          ...buildPlaceRequest({ menuToken: menu.menuToken, lines, tip: tip.tip, promoCodes: promoCodes, quote }),
          ...(editing ? { expectedVersion: editing.version } : {}),
        },
        { 'idempotency-key': pendingKey },
        editing ? 'PUT' : 'POST',
      );
    } catch (err) {
      endBusy();
      // We cannot tell whether the request got through. The key is kept: trying again sends the same key,
      // so if it did go through the customer gets that result back, not a second one.
      notices = [`${networkMessage(err)} We couldn't confirm your order was ${verb}; if it was, trying again will not ${editing ? 'apply it' : 'place it'} twice.`];
      renderSummary();
      return;
    }

    if (res.ok) {
      // Placed (or recognised as already placed). Keep the page locked while we move to the status page.
      $('busyLabel').textContent = 'Opening your order…';
      location.assign(res.data.trackPath ?? `/track/${encodeURIComponent(res.data.order.id)}`);
      return;
    }
    endBusy();

    if (res.status === 409 && res.data.error === 'confirmation_required') {
      // Something differs from what the customer was shown. Nothing was placed. Ask them.
      const hold = describeHold(res.data, { appliedBefore });
      last = { quote: res.data.quote, appliedCodes: hold.appliedCodes };
      promoCodes = hold.appliedCodes; // a refused code is removed from the box
      const choice = await askConfirm(hold.notices, res.data.quote.totalCents);
      if (choice === 'cancel') {
        // Back to the order screen, showing the corrected figures, without placing anything.
        status = STATUS.NEEDS_CONFIRM;
        notices = hold.notices;
        acceptLabel = hold.acceptLabel;
        renderSummary();
        $('accept')?.focus();
        return;
      }
      if (++holds >= 3) {
        status = STATUS.STALE;
        notices = ['The prices keep changing. Please check your total again.'];
        pendingKey = null;
        renderSummary();
        return;
      }
      // OK: the customer has seen the updated figures; place the order with those.
      status = STATUS.CONFIRMED;
      quote = res.data.quote;
      appliedBefore = hold.appliedCodes;
      renderSummary();
      continue;
    }

    if (editing && res.status === 409 && ['order_locked', 'order_cancelled'].includes(res.data.error)) {
      // The kitchen got there first. Nothing was changed.
      lockEdit('locked', res.data.message);
    } else if (editing && res.status === 409 && res.data.error === 'order_changed') {
      lockEdit('changed', res.data.message);
    } else if (res.status === 409 && ['menu_expired', 'menu_unknown'].includes(res.data.error)) {
      pendingKey = null;
      expire(res.data.message);
    } else if (res.status === 422 && res.data.error === 'invalid_order') {
      pendingKey = null;
      status = STATUS.ERROR;
      notices = (res.data.issues ?? []).map((i) => i.message);
    } else if (res.status >= 500) {
      // Our side failed before anything was committed (or the restaurant was slow to answer): safe to try again with the same key.
      notices = ['Something went wrong on our side. Please try placing your order again.'];
    } else {
      pendingKey = null;
      status = STATUS.STALE;
      notices = [res.data.message ?? `We could not save your ${editing ? 'changes' : 'order'}. Please check your total and try again.`];
    }
    renderSummary();
    return;
  }
}

// ------------------------------------------- changing an order: staying in step ---
// While a customer is changing an order, the order is watched. The moment it is no longer Not Started
// (the kitchen started it, it was delivered, or it was cancelled) they are told at once, even half-way
// through an edit, and nothing more can be changed. The service refuses a late save too; this is so
// they hear about it before they have spent their time on it.

let locked = false;

/** Stop the edit and tell the customer why. kind: 'locked' (the order moved on) or 'changed' (changed in another window). */
function lockEdit(kind, message) {
  if (locked) return;
  locked = true;
  clearInterval(watchTimer);
  status = STATUS.LOCKED;
  pendingKey = null;
  notices = [];
  $('lockedTitle').textContent = kind === 'locked' ? 'This order can no longer be changed' : 'This order was changed somewhere else';
  $('lockedText').textContent = message;
  $('lockedBack').href = `/track/${encodeURIComponent(editing.id)}`;
  $('lockedReload').hidden = kind !== 'changed';
  $('lockedBack').hidden = kind === 'changed';
  for (const other of ['confirm', 'timeout']) if ($(other).open) $(other).close(); // the alert takes over
  renderSummary();
  if (!$('locked').open) $('locked').showModal();
  $('lockedReload').hidden ? $('lockedBack').focus() : $('lockedReload').focus();
}
$('locked').addEventListener('cancel', (e) => e.preventDefault());
$('lockedReload').addEventListener('click', () => location.reload());

async function watchOrder() {
  if (!editing || locked || busyCount > 0) return; // a request in flight will hear the answer itself
  let order = null;
  try {
    const res = await fetch(`/orders/${encodeURIComponent(editing.id)}`, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    if (res.ok) order = (await res.json()).order;
    else if (res.status === 404) return;
  } catch {
    return; // could not look this time; the next look decides
  }
  const verdict = watchVerdict(order, { version: editing.version });
  if (verdict.verdict !== 'ok') lockEdit(verdict.verdict, verdict.message);
}

// ------------------------------------------------------- session countdown ---

function tick() {
  if (!menu) return;
  const left = secondsLeft({ expiresAt: menu.expiresAt, serverTime: menu.serverTime, loadedAtMs, nowMs: Date.now() });
  const session = $('session');
  session.hidden = false;
  if (status === STATUS.EXPIRED || left === 0) {
    session.textContent = 'Your session has timed out.';
    session.className = 'sub soon';
    if (status !== STATUS.EXPIRED) expire();
    return;
  }
  const by = new Date(Date.now() + left * 1000).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  session.textContent = `Prices are held for ${formatCountdown(left)}: please place your order by ${by}.`;
  session.className = left <= SOON_SECONDS ? 'sub soon' : 'sub';
}
setInterval(tick, 1000);

function expire(message) {
  status = STATUS.EXPIRED;
  if (message) $('timeoutText').textContent = message;
  renderSummary();
  if (!$('timeout').open) $('timeout').showModal();
}

async function renewSession() {
  beginBusy('Getting new prices…');
  try {
    const fresh = await loadMenu();
    const carried = carryOver(lines, fresh);
    applyMenu(fresh);
    $('lines').replaceChildren();
    lines.length = 0;
    for (const l of carried.lines) { lines.push(l); $('lines').append(buildLine(l)); }
    if (lines.length === 0) addLine();
    syncRemoveButtons();

    status = STATUS.STALE;
    last = null;
    notices = ['Prices were refreshed and may have changed. Check your total again.'];
    if (carried.dropped.length) notices.push(`No longer on the menu, so removed from your order: ${carried.dropped.join(', ')}.`);
    $('timeout').close();
    renderSummary();
    tick();
  } catch (err) {
    $('timeoutText').textContent = err instanceof Error && err.message ? err.message : 'We could not get new prices. Please try again.';
  } finally {
    endBusy();
  }
}
$('renew').addEventListener('click', renewSession);

// ------------------------------------------------------------------- start ---

async function loadMenu() {
  let res;
  try {
    res = await fetch('/api/menu', { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  } catch (err) {
    throw new Error(networkMessage(err));
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.message || `Could not load the menu (${res.status})`);
  return body;
}

function applyMenu(fresh) {
  menu = fresh;
  loadedAtMs = Date.now();
  renderMenu();
}

/** Load the order to be changed. Returns it, or null after explaining on the page why it can't be changed. */
async function loadOrderToChange() {
  const back = el('a', { href: `/track/${encodeURIComponent(editId)}` }, 'Back to my order');
  const explain = (message) => {
    showError(message);
    $('error').append(' ', back);
    $('menuInfo').textContent = '';
  };
  let res;
  try {
    res = await fetch(`/orders/${encodeURIComponent(editId)}`, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  } catch (err) {
    explain(networkMessage(err));
    return null;
  }
  if (res.status === 404) return explain('We could not find that order.'), null;
  if (!res.ok) return explain('We could not load that order. Please try again.'), null;
  const order = (await res.json()).order;
  if (!order.canEdit) return explain(lockedMessage(order.status)), null; // already past the point of changing it
  return order;
}

const STATUS_WORDS = {
  NOT_STARTED: ['Not started', "The kitchen hasn't started it, so you can still change it."],
  STARTED: ['Started', 'The kitchen is making it.'],
  READY_FOR_PICKUP: ['Ready for pickup', 'It is ready.'],
  DELIVERED: ['Delivered', 'It has been delivered.'],
  CANCELLED: ['Cancelled', 'It was cancelled.'],
};

/** "Your order right now": the saved order as it stands, read-only, so the customer sees what they are changing. */
function renderCurrentOrder(order) {
  const [label, meaning] = STATUS_WORDS[order.status] ?? [order.status, ''];
  $('currentStatus').replaceChildren(el('span', { class: 'badge' }, label), meaning);

  $('currentLines').replaceChildren(
    ...order.lines.map((l) => {
      const li = el('li', {}, el('span', {}, `${l.quantity} × ${l.size.label}`));
      if (l.toppings.length) li.firstChild.append(el('span', { class: 'topping' }, ` — ${l.toppings.map((t) => t.label).join(', ')}`));
      li.append(el('span', {}, money(l.lineTotalCents)));
      return li;
    }),
  );

  const p = order.pricing;
  const rows = [['Subtotal', money(p.subtotalCents)]];
  for (const promo of p.promos) rows.push([`Promo ${promo.code}`, `−${money(promo.discountCents)}`]);
  rows.push(['Tax', money(p.taxCents)]);
  if (p.tip.cents > 0) rows.push(['Tip', money(p.tip.cents)]);
  const dl = el('dl', {});
  for (const [k, v] of rows) dl.append(el('dt', {}, k), el('dd', {}, v));
  dl.append(el('dt', { class: 'total' }, 'Total'), el('dd', { class: 'total' }, money(p.totalCents)));
  $('currentPricing').replaceChildren(dl);

  $('currentHistory').textContent =
    order.revision > 1 && order.original
      ? `Changed ${order.revision - 1} time${order.revision > 2 ? 's' : ''} since it was placed. First placed at ${money(order.original.totalCents)}.`
      : '';
}

/** Fill the page from the order being changed, and say where the customer is. */
function beginEdit(order) {
  editing = {
    id: order.id,
    version: order.version,
    current: { subtotalCents: order.pricing.subtotalCents, discountCents: order.pricing.discountCents, taxCents: order.pricing.taxCents, tip: order.pricing.tip, totalCents: order.totalCents },
    originalTotal: order.original ? order.original.totalCents : null,
    appliedCodes: order.pricing.promos.map((p) => p.code),
  };

  const rebuilt = linesFromOrder(order, menu);
  for (const l of rebuilt.lines) {
    const line = { id: nextId++, ...l };
    lines.push(line);
    $('lines').append(buildLine(line));
  }
  if (lines.length === 0) addLine();
  syncRemoveButtons();

  const tip = tipInputsFromOrder(order.pricing.tip);
  $('tipMode').value = tip.mode;
  $('tipMode').dispatchEvent(new Event('change')); // shows the right box and label
  $('tipValue').value = tip.text;
  promoCodes = [...editing.appliedCodes];

  renderCurrentOrder(order);
  $('currentCard').hidden = false;
  $('orderTitle').textContent = 'Change your order';

  document.title = 'Change your order';
  $('heading').textContent = 'Change your order';
  $('editBannerText').textContent = `Changing order ${order.id.slice(0, 8)}, currently ${money(order.totalCents)}. You can change it until the kitchen starts it.`;
  $('editBack').href = `/track/${encodeURIComponent(order.id)}`;
  $('editBanner').hidden = false;

  notices = rebuilt.dropped.length ? [`No longer on the menu, so removed from your order: ${rebuilt.dropped.join(', ')}.`] : [];
}

async function start() {
  try {
    applyMenu(await loadMenu());
  } catch (err) {
    $('menuInfo').textContent = '';
    showError(err.message);
    return;
  }
  showError(null);

  let toChange = null;
  if (editId) {
    toChange = await loadOrderToChange();
    if (!toChange) return;
  }

  $('menuCard').hidden = false;
  $('orderCard').hidden = false;
  if (toChange) beginEdit(toChange);
  else addLine();
  renderSummary();
  tick();

  if (toChange) {
    watchTimer = setInterval(watchOrder, WATCH_MS);
    // Price the order as it stands on today's menu straight away, so the comparison is on screen.
    await check('Checking your order against today’s prices…');
  }
}

start();

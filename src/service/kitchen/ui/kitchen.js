// Kitchen screen. No build step, no framework.
// The server decides what each order may do next (nextStatus / canCancel); this file has no rules.

const STATUS_LABEL = {
  NOT_STARTED: 'Not started',
  STARTED: 'Started',
  READY_FOR_PICKUP: 'Ready for pickup',
  DELIVERED: 'Delivered',
  CANCELLED: 'Cancelled',
};
const ACTION_LABEL = { STARTED: 'Start cooking', READY_FOR_PICKUP: 'Mark ready', DELIVERED: 'Mark delivered' };
const POLL_MS = 3000;

const list = document.getElementById('orders');
const errorBox = document.getElementById('error');
const statusEl = document.getElementById('status');
const showClosed = document.getElementById('showClosed');

const cancelling = new Map(); // order id -> reason typed so far, for orders whose cancel form is open
const busy = new Set(); // order ids with a request in flight
let timer;

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') node.className = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else node[k] = v;
  }
  node.append(...children);
  return node;
}

function money(cents) {
  return `$${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, '0')}`;
}

function ago(iso) {
  const mins = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  return `${Math.floor(mins / 60)} h ${mins % 60} min ago`;
}

function showError(message) {
  errorBox.hidden = !message;
  errorBox.textContent = message ?? '';
}

async function call(path, body) {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.message || `request failed (${res.status})`);
  return data;
}

async function act(id, path, body) {
  busy.add(id);
  render(lastOrders);
  try {
    await call(path, body);
    showError(null);
    cancelling.delete(id);
  } catch (err) {
    // e.g. "Order has been cancelled" when the customer cancelled while this screen was stale.
    // The refresh below then shows the order's real status.
    showError(err.message);
    cancelling.delete(id);
  } finally {
    busy.delete(id);
    await refresh();
  }
}

function orderCard(o) {
  const closed = o.status === 'DELIVERED' || o.status === 'CANCELLED';
  const card = el('li', { class: `order${closed ? ' closed' : ''}` });

  card.append(
    el(
      'div',
      { class: 'top' },
      el('span', { class: `badge ${o.status}` }, STATUS_LABEL[o.status] ?? o.status),
      el('span', { class: 'when', title: new Date(o.createdAt).toLocaleString() }, `Received ${new Date(o.createdAt).toLocaleTimeString()} (${ago(o.createdAt)})`),
      el('span', { class: 'when' }, money(o.totalCents)),
      el('span', { class: 'id' }, o.id.slice(0, 8)),
    ),
  );

  const items = el('ul', { class: 'items' });
  for (const line of o.items) {
    const li = el('li', {}, `${line.quantity} × ${line.size}`);
    if (line.toppings.length) li.append(el('span', { class: 'topping' }, ` — ${line.toppings.join(', ')}`));
    items.append(li);
  }
  card.append(items);

  if (o.cancellationReason) card.append(el('div', { class: 'reason' }, `Cancelled: ${o.cancellationReason}`));

  const disabled = busy.has(o.id);
  const actions = el('div', { class: 'actions' });
  if (o.nextStatus) {
    actions.append(
      el('button', { class: 'primary', disabled, onclick: () => act(o.id, `/kitchen/orders/${o.id}/advance`, { expectedStatus: o.status }) }, ACTION_LABEL[o.nextStatus] ?? 'Next'),
    );
  }
  if (o.canCancel && !cancelling.has(o.id)) {
    actions.append(el('button', { class: 'danger', disabled, onclick: () => { cancelling.set(o.id, ''); render(lastOrders); focusReason(o.id); } }, 'Cancel…'));
  }
  if (o.canCancel && cancelling.has(o.id)) {
    const reason = el('input', { type: 'text', maxLength: 200, value: cancelling.get(o.id), placeholder: 'Reason (optional)', ariaLabel: 'Cancellation reason' });
    reason.dataset.orderId = o.id;
    reason.addEventListener('input', () => cancelling.set(o.id, reason.value));
    actions.append(
      reason,
      // expectedStatus: what this screen last saw; the service re-checks the real status anyway.
      el('button', { class: 'danger', disabled, onclick: () => act(o.id, `/kitchen/orders/${o.id}/cancel`, { reason: reason.value, expectedStatus: o.status }) }, 'Confirm cancel'),
      el('button', { disabled, onclick: () => { cancelling.delete(o.id); render(lastOrders); } }, 'Keep order'),
    );
  }
  if (actions.children.length) card.append(actions);
  return card;
}

let lastOrders = [];

function focusReason(id) {
  const input = [...list.querySelectorAll('input[data-order-id]')].find((i) => i.dataset.orderId === id);
  if (input) {
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
  }
}

function render(orders) {
  lastOrders = orders;
  // A cancel form for an order that can no longer be cancelled (the customer got there first,
  // or it was delivered) is closed; the card shows the new status instead.
  for (const o of orders) if (!o.canCancel) cancelling.delete(o.id);

  // Re-rendering replaces the inputs, so remember which one the user is typing in.
  const typingIn = document.activeElement?.dataset?.orderId;

  if (!orders.length) {
    list.replaceChildren(el('li', { class: 'empty' }, 'No orders to show.'));
    return;
  }
  list.replaceChildren(...orders.map(orderCard));
  if (typingIn) focusReason(typingIn);
}

// Poll continuously, including while a cancel form is open: typed text lives in `cancelling`,
// so a refresh never loses it, and an order cancelled elsewhere shows up within one interval.
async function refresh() {
  clearTimeout(timer);
  try {
    const res = await fetch(`/kitchen/orders${showClosed.checked ? '?include=closed' : ''}`);
    if (!res.ok) throw new Error(`could not load orders (${res.status})`);
    render((await res.json()).orders);
    statusEl.textContent = `Updated ${new Date().toLocaleTimeString()}`;
  } catch (err) {
    statusEl.textContent = 'Connection problem — retrying';
    console.error(err);
  }
  timer = setTimeout(refresh, POLL_MS);
}

showClosed.addEventListener('change', refresh);
refresh();

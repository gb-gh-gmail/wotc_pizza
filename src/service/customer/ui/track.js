// Customer order-status page. Polls the order, shows where it is, and lets the
// customer cancel while the kitchen has not started. The server decides whether
// cancelling is allowed (order.canCancel); this file has no rules of its own.
//
// Cancelling sends the status this page last saw. The service re-checks the real
// status at that moment and refuses if it changed, so a stale page cannot cancel
// an order the kitchen has just started.

const STEPS = [
  ['NOT_STARTED', 'Received'],
  ['STARTED', 'Cooking'],
  ['READY_FOR_PICKUP', 'Ready'],
  ['DELIVERED', 'Delivered'],
];
const HEADLINE = {
  NOT_STARTED: "We've got your order — the kitchen hasn't started yet",
  STARTED: 'The kitchen is making your order',
  READY_FOR_PICKUP: 'Your order is ready for pickup',
  DELIVERED: 'Your order has been delivered',
  CANCELLED: 'Your order was cancelled',
};
const POLL_MS = 3000;

const id = decodeURIComponent(location.pathname.split('/').filter(Boolean).pop() ?? '');
const $ = (name) => document.getElementById(name);

let order = null; // last order we showed; its status is what a cancel request will assert
let cancelling = false;
let busy = false;
let draft = '';
let timer;

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else node[k] = v;
  }
  node.append(...children);
  return node;
}

function showError(message) {
  $('error').hidden = !message;
  $('error').textContent = message ?? '';
}

function render() {
  $('orderId').textContent = `Order ${id.slice(0, 8)}`;
  if (!order) return;
  $('card').hidden = false;
  $('headline').textContent = HEADLINE[order.status] ?? order.status;

  const steps = $('steps');
  steps.className = order.status === 'CANCELLED' ? 'steps cancelled' : 'steps';
  const at = STEPS.findIndex(([s]) => s === order.status);
  steps.replaceChildren(
    ...STEPS.map(([, label], i) => el('li', { className: i < at ? 'done' : i === at ? 'current' : '' }, label)),
  );

  $('items').replaceChildren(
    ...order.items.map((line) => {
      const li = el('li', {}, `${line.quantity} × ${line.size}`);
      if (line.toppings.length) li.append(el('span', { className: 'topping' }, ` — ${line.toppings.join(', ')}`));
      return li;
    }),
  );
  $('reason').textContent = order.cancellationReason ? `Reason: ${order.cancellationReason}` : '';

  // If the order moved on while the form was open, the form is no longer valid.
  if (!order.canCancel) cancelling = false;

  const actions = $('actions');
  actions.replaceChildren();
  if (order.canCancel && !cancelling) {
    actions.append(el('button', { className: 'danger', onclick: () => { cancelling = true; render(); } }, 'Cancel order…'));
  } else if (order.canCancel && cancelling) {
    const reason = el('input', { type: 'text', maxLength: 200, value: draft, placeholder: 'Reason (optional)', ariaLabel: 'Cancellation reason' });
    reason.addEventListener('input', () => { draft = reason.value; });
    actions.append(
      reason,
      el('button', { className: 'danger', disabled: busy, onclick: cancel }, 'Confirm cancel'),
      el('button', { disabled: busy, onclick: () => { cancelling = false; render(); } }, 'Keep order'),
    );
  }
}

async function load() {
  const res = await fetch(`/orders/${encodeURIComponent(id)}`);
  if (res.status === 404) {
    const err = new Error('We could not find that order.');
    err.final = true; // retrying will not make it appear
    throw err;
  }
  if (!res.ok) throw new Error(`Could not load your order (${res.status})`);
  order = (await res.json()).order;
  $('checked').textContent = `Checked ${new Date().toLocaleTimeString()}`;
}

async function cancel() {
  busy = true;
  render();
  try {
    const res = await fetch(`/orders/${encodeURIComponent(id)}/cancel`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      // expectedStatus: the status the customer was looking at when they pressed the button.
      body: JSON.stringify({ expectedStatus: order.status, reason: draft }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.message || `Cancel failed (${res.status})`);
    showError(null);
    cancelling = false;
  } catch (err) {
    showError(err.message); // e.g. "Order status has changed since you last checked…"
    cancelling = false;
  } finally {
    busy = false;
    await refresh();
  }
}

async function refresh() {
  clearTimeout(timer);
  let stop = false;
  try {
    await load();
    render();
  } catch (err) {
    showError(err.message);
    stop = err.final === true;
  }
  // No polling for an order in a final status (nothing can change), or one that does not exist.
  if (order && (order.status === 'DELIVERED' || order.status === 'CANCELLED')) stop = true;
  if (!stop) timer = setTimeout(refresh, POLL_MS);
}

refresh();

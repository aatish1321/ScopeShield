import { randomUUID } from 'node:crypto';
import { AppError, parseAmount } from './validation.js';
import { publicProposal } from './store.js';

const base = 'https://api-m.sandbox.paypal.com';
// shortcut: recovery stops before PayPal's six-hour create-key retention, manual reconciliation beyond this window.
const recoveryWindow = 5 * 60 * 60 * 1000;
const amountText = cents => `${Math.trunc(cents / 100)}.${String(cents % 100).padStart(2, '0')}`;
const validId = id => typeof id === 'string' && /^[A-Z0-9]{8,40}$/i.test(id);

function approvalLink(order) {
  const href = order.links?.find(link => ['payer-action', 'approve'].includes(link.rel))?.href;
  if (!href) return null;
  let url;
  try { url = new URL(href); } catch { throw new AppError(502, 'PayPal returned an invalid checkout link.'); }
  if (url.protocol !== 'https:' || !['www.sandbox.paypal.com', 'sandbox.paypal.com'].includes(url.hostname) ||
      url.port || url.username || url.password || url.hash ||
      !['/checkoutnow', '/webapps/hermes'].includes(url.pathname) || url.searchParams.get('token') !== order.id) {
    throw new AppError(502, 'PayPal returned an unexpected checkout link.');
  }
  return url.href;
}

export function createPayments(store, config, { fetchApi = fetch, now = Date.now } = {}) {
  const configured = Boolean(config.paypalClientId && config.paypalSecret);
  const active = new Set();
  let access;
  let authenticating;

  async function accessToken() {
    if (access && access.until > now()) return access.token;
    if (authenticating) return authenticating;
    authenticating = (async () => {
      const response = await fetchApi(`${base}/v1/oauth2/token`, {
        method: 'POST',
        headers: {
          Authorization: `Basic ${Buffer.from(`${config.paypalClientId}:${config.paypalSecret}`).toString('base64')}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: 'grant_type=client_credentials', signal: AbortSignal.timeout(20000),
      });
      if (!response.ok) throw new AppError(502, 'PayPal sandbox authentication failed. Check the server credentials.');
      const body = await response.json();
      if (typeof body.access_token !== 'string' || !Number.isFinite(body.expires_in) || body.expires_in <= 60) {
        throw new AppError(502, 'PayPal returned an invalid authentication response.');
      }
      access = { token: body.access_token, until: now() + (body.expires_in - 60) * 1000 };
      return access.token;
    })();
    try { return await authenticating; } finally { authenticating = null; }
  }

  async function request(path, { method = 'GET', body, requestId } = {}) {
    try {
      const token = await accessToken();
      const response = await fetchApi(`${base}${path}`, {
        method, signal: AbortSignal.timeout(20000),
        headers: {
          Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Prefer: 'return=representation',
          ...(requestId ? { 'PayPal-Request-Id': requestId } : {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      if (!response.ok) {
        if (response.status === 401) access = null;
        throw new AppError(response.status === 429 ? 429 : 502,
          'PayPal could not confirm this operation. Check payment status before retrying; no new order will be created while the result is uncertain.');
      }
      return await response.json();
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError(502, 'PayPal could not be reached. Payment outcome is unconfirmed; use Check payment status before retrying.');
    }
  }

  function get(token) {
    const row = store.get(token);
    if (!row) throw new AppError(404, 'Proposal unavailable. Check the link with your freelancer.');
    return row;
  }

  async function locked(token, operation) {
    if (!configured) throw new AppError(503, 'PayPal sandbox checkout is not configured on this server.');
    if (active.has(token)) throw new AppError(409, 'A payment operation is already running. Wait, then check payment status.');
    active.add(token);
    try { return await operation(get(token)); } finally { active.delete(token); }
  }

  function verifyAmount(amount, row) {
    try { return amount?.currency_code === row.currency && parseAmount(amount.value) === row.amount_cents; }
    catch { return false; }
  }

  function applyOrder(row, order) {
    const units = order.purchase_units;
    const unit = units?.[0];
    if (order.id !== row.order_id || !Array.isArray(units) || units.length !== 1 ||
        unit.reference_id !== row.id || unit.custom_id !== row.id || !verifyAmount(unit.amount, row) ||
        !unit.payee?.merchant_id || (row.merchant_id && unit.payee.merchant_id !== row.merchant_id)) {
      throw new AppError(502, 'PayPal order verification failed. Do not retry payment; contact your freelancer.');
    }
    const captures = unit.payments?.captures || [];
    if (!Array.isArray(captures) || captures.length > 1) throw new AppError(502, 'PayPal capture verification failed. Contact your freelancer.');
    const capture = captures[0];
    if (capture && (!validId(capture.id) || !verifyAmount(capture.amount, row) ||
        (row.capture_id && capture.id !== row.capture_id))) {
      throw new AppError(502, 'PayPal capture verification failed. Do not retry payment; contact your freelancer.');
    }
    let status;
    if (capture?.status === 'COMPLETED' && order.status !== 'COMPLETED') {
      throw new AppError(502, 'PayPal returned inconsistent payment status. Check payment status before making changes.');
    }
    if (capture?.status === 'COMPLETED' && order.status === 'COMPLETED') status = 'paid';
    else if (capture?.status === 'PENDING') status = 'pending';
    else if (capture || order.status === 'VOIDED') status = 'failed';
    else if (['CREATED', 'SAVED', 'PAYER_ACTION_REQUIRED', 'APPROVED'].includes(order.status)) status = 'ready';
    else throw new AppError(502, 'PayPal payment state is unconfirmed. Contact your freelancer before retrying.');
    return store.updatePayment(row.token, {
      merchant_id: unit.payee.merchant_id, payment_status: status,
      capture_id: capture?.id || null,
      paid_at: status === 'paid' ? new Date(now()).toISOString() : null,
    });
  }

  async function reconcile(row) {
    if (!row.order_id || row.payment_status === 'paid') return { row, order: null };
    const order = await request(`/v2/checkout/orders/${row.order_id}`);
    return { row: applyOrder(row, order), order };
  }

  function checkRecovery(started) {
    const age = now() - Date.parse(started);
    if (!Number.isFinite(age) || age < 0 || age >= recoveryWindow) {
      throw new AppError(409, 'Automatic payment recovery has expired. Contact your freelancer for manual reconciliation; do not start another payment.');
    }
  }

  const view = row => ({ ...publicProposal(row), checkoutAvailable: configured });
  return {
    configured,
    remove(token) {
      if (active.has(token)) throw new AppError(409, 'A payment operation is running. Wait, then check payment status before deleting.');
      const row = get(token);
      if (['creating', 'capturing', 'pending', 'unknown'].includes(row.payment_status) ||
          (row.capture_request_id && !['paid', 'failed'].includes(row.payment_status))) {
        throw new AppError(409, 'Check and resolve the payment outcome before deleting this proposal.');
      }
      store.remove(token);
    },
    async status(token) {
      return locked(token, async row => view((await reconcile(row)).row));
    },
    async checkout(token, accepted) {
      return locked(token, async row => {
        if (row.payment_status === 'paid') return { proposal: view(row), approvalUrl: null };
        if (accepted !== true) throw new AppError(400, 'Accept the proposal terms before starting PayPal checkout.');
        if (!row.accepted_at) row = store.updatePayment(token, { accepted_at: new Date(now()).toISOString() });
        if (row.order_id) {
          row = (await reconcile(row)).row;
        } else {
          if (row.create_request_id) checkRecovery(row.create_started_at);
          else row = store.updatePayment(token, {
            create_request_id: randomUUID(), create_started_at: new Date(now()).toISOString(), payment_status: 'creating',
          });
          const order = await request('/v2/checkout/orders', {
            method: 'POST', requestId: row.create_request_id,
            body: {
              intent: 'CAPTURE',
              purchase_units: [{
                reference_id: row.id, custom_id: row.id, invoice_id: row.id,
                description: row.title.slice(0, 127), amount: { currency_code: row.currency, value: amountText(row.amount_cents) },
              }],
              payment_source: { paypal: { experience_context: {
                shipping_preference: 'NO_SHIPPING', user_action: 'PAY_NOW',
                return_url: `${config.appUrl.origin}/p/${token}?paypal=return`,
                cancel_url: `${config.appUrl.origin}/p/${token}?paypal=cancel`,
              } } },
            },
          });
          if (!validId(order.id)) throw new AppError(502, 'PayPal did not confirm an order. Check payment status before retrying.');
          // Save the order ID before validating any other response fields, so an uncertain order is never replaced.
          row = store.updatePayment(token, { order_id: order.id, payment_status: 'unknown' });
          const url = approvalLink(order);
          if (url) row = store.updatePayment(token, { approval_url: url });
          row = (await reconcile(row)).row;
        }
        if (['paid', 'pending', 'failed'].includes(row.payment_status)) return { proposal: view(row), approvalUrl: null };
        if (!row.approval_url) throw new AppError(502, 'PayPal did not provide an approval link. Contact your freelancer.');
        return { proposal: view(row), approvalUrl: row.approval_url };
      });
    },
    async capture(token) {
      return locked(token, async row => {
        if (row.payment_status === 'paid') return view(row);
        if (!row.accepted_at || !row.order_id) throw new AppError(409, 'Start checkout and approve the payment with PayPal first.');
        const reconciled = await reconcile(row);
        row = reconciled.row;
        if (['paid', 'pending', 'failed'].includes(row.payment_status)) return view(row);
        if (reconciled.order?.status !== 'APPROVED') throw new AppError(409, 'Payment has not been approved in PayPal. Continue checkout first.');
        if (row.capture_request_id) checkRecovery(row.capture_started_at);
        else row = store.updatePayment(token, { capture_request_id: randomUUID(), capture_started_at: new Date(now()).toISOString() });
        row = store.updatePayment(token, { payment_status: 'capturing' });
        await request(`/v2/checkout/orders/${row.order_id}/capture`, { method: 'POST', body: {}, requestId: row.capture_request_id });
        return view((await reconcile(row)).row);
      });
    },
  };
}

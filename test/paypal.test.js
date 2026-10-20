import test from 'node:test';
import assert from 'node:assert/strict';
import { createPayments } from '../src/paypal.js';
import { openStore } from '../src/store.js';

const config = { paypalClientId: 'test-client', paypalSecret: 'private-test-secret', appUrl: new URL('http://localhost:3000') };
const json = value => new Response(JSON.stringify(value));

function fakePayPal() {
  const orders = new Map();
  const requestIds = new Map();
  const calls = [];
  const fake = { orders, calls, loseCreate: false, loseCapture: false, pending: false, badLink: false };
  fake.fetchApi = async (url, options) => {
    calls.push({ url, options });
    assert.ok(url.startsWith('https://api-m.sandbox.paypal.com/'));
    if (url.endsWith('/v1/oauth2/token')) return json({ access_token: 'synthetic-token', expires_in: 3600 });
    assert.equal(options.headers.Authorization, 'Bearer synthetic-token');
    const body = options.body ? JSON.parse(options.body) : null;
    if (url.endsWith('/v2/checkout/orders') && options.method === 'POST') {
      const requestId = options.headers['PayPal-Request-Id'];
      assert.ok(requestId);
      if (requestIds.has(requestId)) return json(orders.get(requestIds.get(requestId)));
      const id = `ORDER${String(orders.size + 1).padStart(12, '0')}`;
      const order = {
        id, status: 'PAYER_ACTION_REQUIRED',
        purchase_units: [{ ...body.purchase_units[0], payee: { merchant_id: 'MERCHANT1234' } }],
        links: [{ rel: 'payer-action', href: `${fake.badLink ? 'https://attacker.example' : 'https://www.sandbox.paypal.com'}/checkoutnow?token=${id}` }],
      };
      orders.set(id, order);
      requestIds.set(requestId, id);
      if (fake.loseCreate) { fake.loseCreate = false; throw new Error('response lost after create'); }
      return json(order);
    }
    const id = url.split('/')[6];
    const order = orders.get(id);
    assert.ok(order, `Unexpected test order: ${id}`);
    if (url.endsWith('/capture')) {
      assert.equal(options.method, 'POST');
      assert.equal(order.status, 'APPROVED');
      assert.ok(options.headers['PayPal-Request-Id']);
      order.status = 'COMPLETED';
      order.purchase_units[0].payments = { captures: [{ id: 'CAPTURE12345678901', status: fake.pending ? 'PENDING' : 'COMPLETED',
        amount: { ...order.purchase_units[0].amount }, final_capture: true }] };
      if (fake.loseCapture) { fake.loseCapture = false; throw new Error('response lost after capture'); }
      return json(order);
    }
    assert.equal(options.method, 'GET');
    return json(order);
  };
  return fake;
}

function setup(t) {
  const store = openStore(':memory:');
  t.after(() => store.close());
  const row = store.create({ title: 'Store addition', work: 'Ten products', delivery: 'Five days', amountCents: 25000 });
  const fake = fakePayPal();
  let time = Date.parse('2026-10-20T12:00:00Z');
  const now = () => time;
  const payments = createPayments(store, config, { fetchApi: fake.fetchApi, now });
  const remote = () => fake.orders.values().next().value;
  return { store, row, fake, payments, remote, now, advance: duration => { time += duration; } };
}

const capturePosts = fake => fake.calls.filter(call => call.url.endsWith('/capture')).length;

test('checkout requires explicit acceptance and uses only stored USD terms', async t => {
  const { payments, fake, row, store } = setup(t);
  await assert.rejects(payments.checkout(row.token, false), { status: 400 });
  assert.equal(fake.calls.length, 0);
  assert.equal(store.get(row.token).accepted_at, null);
  const value = await payments.checkout(row.token, true);
  assert.equal(value.proposal.status, 'ready');
  assert.match(value.approvalUrl, /^https:\/\/www\.sandbox\.paypal\.com\/checkoutnow/);
  const create = fake.calls.find(call => call.url.endsWith('/v2/checkout/orders'));
  const body = JSON.parse(create.options.body);
  assert.deepEqual(body.purchase_units[0].amount, { currency_code: 'USD', value: '250.00' });
  assert.equal(body.purchase_units[0].reference_id, row.id);
  assert.equal(body.purchase_units[0].custom_id, row.id);
  assert.equal(body.payment_source.paypal.experience_context.shipping_preference, 'NO_SHIPPING');
  assert.ok(store.get(row.token).accepted_at);
  assert.ok(store.get(row.token).create_request_id);
  assert.equal(store.get(row.token).merchant_id, 'MERCHANT1234');
});

test('approval precedes capture; successful and repeated captures cannot charge twice', async t => {
  const { payments, fake, row, remote } = setup(t);
  await payments.checkout(row.token, true);
  await assert.rejects(payments.capture(row.token), { status: 409 });
  assert.equal(capturePosts(fake), 0);
  remote().status = 'APPROVED';
  const result = await payments.capture(row.token);
  assert.equal(result.status, 'paid');
  assert.equal(result.captureId, 'CAPTURE12345678901');
  assert.ok(result.paidAt);
  assert.equal((await payments.capture(row.token)).status, 'paid');
  assert.equal((await payments.checkout(row.token, true)).approvalUrl, null);
  assert.equal(capturePosts(fake), 1);
  assert.equal(fake.orders.size, 1);
});

test('cancellation/retry reuses the same order and never captures an unapproved order', async t => {
  const { payments, fake, row } = setup(t);
  const first = await payments.checkout(row.token, true);
  const second = await payments.checkout(row.token, true);
  assert.equal(first.approvalUrl, second.approvalUrl);
  assert.equal(fake.orders.size, 1);
  assert.equal(capturePosts(fake), 0);
  assert.equal((await payments.status(row.token)).status, 'ready');
});

test('pending captures block new charges and can reconcile to completed', async t => {
  const { payments, fake, row, remote } = setup(t);
  await payments.checkout(row.token, true);
  remote().status = 'APPROVED';
  fake.pending = true;
  assert.equal((await payments.capture(row.token)).status, 'pending');
  assert.equal((await payments.checkout(row.token, true)).approvalUrl, null);
  assert.equal((await payments.capture(row.token)).status, 'pending');
  assert.equal(capturePosts(fake), 1);
  remote().purchase_units[0].payments.captures[0].status = 'COMPLETED';
  assert.equal((await payments.status(row.token)).status, 'paid');
  assert.equal(capturePosts(fake), 1);
});

test('lost create response recovers the same request/order after service restart', async t => {
  const { payments, fake, row, store, now } = setup(t);
  fake.loseCreate = true;
  await assert.rejects(payments.checkout(row.token, true), { status: 502 });
  const requestId = store.get(row.token).create_request_id;
  assert.equal(store.get(row.token).payment_status, 'creating');
  assert.equal(store.get(row.token).order_id, null);
  const resumed = createPayments(store, config, { fetchApi: fake.fetchApi, now });
  assert.equal((await resumed.checkout(row.token, true)).proposal.status, 'ready');
  assert.equal(store.get(row.token).create_request_id, requestId);
  assert.equal(fake.orders.size, 1);
});

test('lost capture response reconciles to paid after service restart without recapturing', async t => {
  const { payments, fake, row, store, remote, now } = setup(t);
  await payments.checkout(row.token, true);
  remote().status = 'APPROVED';
  fake.loseCapture = true;
  await assert.rejects(payments.capture(row.token), { status: 502 });
  assert.equal(store.get(row.token).payment_status, 'capturing');
  assert.ok(store.get(row.token).capture_request_id);
  const resumed = createPayments(store, config, { fetchApi: fake.fetchApi, now });
  assert.equal((await resumed.capture(row.token)).status, 'paid');
  assert.equal(capturePosts(fake), 1);
});

test('concurrent checkout is blocked while the first request is in flight', async t => {
  const { fake, row, store, now } = setup(t);
  let release;
  let entered;
  const gate = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { entered = resolve; });
  const payments = createPayments(store, config, { now, fetchApi: async (url, options) => {
    if (url.endsWith('/v2/checkout/orders') && options.method === 'POST') { entered(); await gate; }
    return fake.fetchApi(url, options);
  } });
  const first = payments.checkout(row.token, true);
  await started;
  await assert.rejects(payments.checkout(row.token, true), { status: 409 });
  assert.ok(store.get(row.token).create_request_id);
  release();
  await first;
  assert.equal(fake.orders.size, 1);
});

test('mismatched order amount, currency, references, merchant or identity cannot be captured', async t => {
  const mutations = [
    order => { order.purchase_units[0].amount.value = '1.00'; },
    order => { order.purchase_units[0].amount.currency_code = 'EUR'; },
    order => { order.purchase_units[0].reference_id = 'other'; },
    order => { order.purchase_units[0].custom_id = 'other'; },
    order => { order.purchase_units[0].payee.merchant_id = 'OTHER-MERCHANT'; },
    order => { order.id = 'OTHERORDER1234'; },
  ];
  for (const mutate of mutations) {
    const { payments, fake, row, remote, store } = setup(t);
    await payments.checkout(row.token, true);
    remote().status = 'APPROVED';
    mutate(remote());
    await assert.rejects(payments.capture(row.token), { status: 502 });
    assert.equal(capturePosts(fake), 0);
    assert.notEqual(store.get(row.token).payment_status, 'paid');
  }
});

test('completed captures with wrong amounts/currencies or changed IDs never mark paid', async t => {
  for (const kind of ['amount', 'currency', 'id']) {
    const { payments, row, remote, store } = setup(t);
    await payments.checkout(row.token, true);
    remote().status = 'COMPLETED';
    remote().purchase_units[0].payments = { captures: [{ id: 'CAPTURE12345678901', status: 'COMPLETED', amount: { currency_code: 'USD', value: '250.00' } }] };
    if (kind === 'amount') remote().purchase_units[0].payments.captures[0].amount.value = '0.01';
    if (kind === 'currency') remote().purchase_units[0].payments.captures[0].amount.currency_code = 'EUR';
    if (kind === 'id') store.updatePayment(row.token, { capture_id: 'OTHER-CAPTURE1234' });
    await assert.rejects(payments.status(row.token), { status: 502 });
    assert.notEqual(store.get(row.token).payment_status, 'paid');
  }
});

test('unknown orders outside recovery window never create a new payment', async t => {
  const { payments, fake, row, advance } = setup(t);
  fake.loseCreate = true;
  await assert.rejects(payments.checkout(row.token, true), { status: 502 });
  advance(6 * 60 * 60 * 1000);
  await assert.rejects(payments.checkout(row.token, true), { status: 409 });
  assert.equal(fake.orders.size, 1);
});

test('invalid approval destination is blocked and its order ID is retained', async t => {
  const { payments, fake, row, store } = setup(t);
  fake.badLink = true;
  await assert.rejects(payments.checkout(row.token, true), { status: 502 });
  assert.ok(store.get(row.token).order_id);
  assert.equal(store.get(row.token).approval_url, null);
  await assert.rejects(payments.checkout(row.token, true), { status: 502 });
  assert.equal(fake.orders.size, 1);
});

test('missing configuration fails closed and database failure prevents capture', async t => {
  const { payments, fake, row, store, remote } = setup(t);
  const unavailable = createPayments(store, {}, { fetchApi: fake.fetchApi });
  await assert.rejects(unavailable.checkout(row.token, true), { status: 503 });
  assert.equal(fake.calls.length, 0);
  await payments.checkout(row.token, true);
  remote().status = 'APPROVED';
  const update = store.updatePayment;
  store.updatePayment = (token, fields) => {
    if (fields.payment_status === 'capturing') throw new Error('disk failure');
    return update(token, fields);
  };
  await assert.rejects(payments.capture(row.token), /disk failure/);
  assert.equal(capturePosts(fake), 0);
});

test('voided orders and failed captures do not start replacement charges', async t => {
  for (const captured of [false, true]) {
    const { payments, fake, row, remote } = setup(t);
    await payments.checkout(row.token, true);
    remote().status = 'VOIDED';
    if (captured) remote().purchase_units[0].payments = { captures: [{ id: 'CAPTURE12345678901', status: 'DECLINED', amount: { currency_code: 'USD', value: '250.00' } }] };
    assert.equal((await payments.checkout(row.token, true)).proposal.status, 'failed');
    assert.equal((await payments.checkout(row.token, true)).approvalUrl, null);
    assert.equal(fake.orders.size, 1);
    assert.equal(capturePosts(fake), 0);
  }
});

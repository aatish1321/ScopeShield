import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request as httpRequest } from 'node:http';
import { createApp } from '../src/server.js';
import { loadConfig } from '../src/validation.js';
import { openStore } from '../src/store.js';
import { hashPassword } from '../src/auth.js';

const password = 'synthetic test passphrase for accounts';
const account = { email: 'owner@example.test', password };
const passwordHash = await hashPassword(password);
const input = { agreement: 'Build three pages.', newRequest: 'Add a store.' };
const result = {
  classification: 'additional', summary: '<img src=x onerror=alert(1)>',
  items: [{ requestExcerpt: 'store', agreementExcerpt: 'three pages', explanation: 'Potential extra work.', suggestedWork: '<script>sample</script>' }],
};
const reply = () => new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(result) } }] }));

async function start(t, options = {}) {
  const config = loadConfig({ GROQ_API_KEY: 'server-private-test-key',
    APP_URL: options.secure ? 'https://127.0.0.1' : 'http://127.0.0.1',
    ...(options.payments ? { PAYPAL_CLIENT_ID: 'test-client', PAYPAL_CLIENT_SECRET: 'test-paypal-secret' } : {}) });
  const store = options.store || openStore(':memory:');
  if (!store.userByEmail(account.email)) store.createUser({ name: 'Test Freelancer', email: account.email, passwordHash });
  const server = createApp(config, { store, fetchApi: options.fetchApi || (async () => reply()), now: options.now || Date.now }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  config.appUrl.port = String(server.address().port);
  t.after(() => new Promise((resolve, reject) => {
    server.closeAllConnections();
    server.close(error => { store.close(); error ? reject(error) : resolve(); });
  }));
  const base = `http://127.0.0.1:${server.address().port}`;
  const request = (path, body, { cookie, headers = {}, ...rest } = {}) => fetch(base + path, {
    method: body === undefined ? 'GET' : 'POST',
    ...rest,
    headers: { ...(body === undefined ? {} : { Origin: config.appUrl.origin, 'Content-Type': 'application/json' }),
      ...(cookie ? { Cookie: cookie } : {}), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const login = async () => {
    const response = await request('/api/login', account);
    assert.equal(response.status, 200);
    return response.headers.get('set-cookie').split(';')[0];
  };
  return { request, login, base, config, store };
}

test('anonymous APIs fail closed; valid login grants analysis; logout revokes session', async t => {
  const { request, login } = await start(t);
  assert.equal((await request('/api/session')).status, 401);
  assert.equal((await request('/api/analyze', input)).status, 401);
  assert.equal((await request('/api/login', { ...account, password: 'wrong test passphrase' })).status, 401);
  const cookie = await login();
  assert.equal((await request('/api/session', undefined, { cookie })).status, 200);
  const analyzed = await request('/api/analyze', input, { cookie });
  assert.equal(analyzed.status, 200);
  assert.deepEqual(await analyzed.json(), result);
  const logout = await request('/api/logout', {}, { cookie });
  assert.equal(logout.status, 200);
  assert.match(logout.headers.get('set-cookie'), /Expires=Thu, 01 Jan 1970/);
  assert.equal((await request('/api/session', undefined, { cookie })).status, 401);
});

test('cookie flags, login token rotation and session expiry', async t => {
  let time = 1000;
  const { request, login } = await start(t, { now: () => time });
  const first = await login();
  const response = await request('/api/login', account, { cookie: first });
  const rawCookie = response.headers.get('set-cookie');
  assert.match(rawCookie, /HttpOnly/);
  assert.match(rawCookie, /SameSite=Strict/);
  assert.match(rawCookie, /Path=\//);
  assert.ok(!rawCookie.includes(password));
  const second = rawCookie.split(';')[0];
  assert.notEqual(first, second);
  assert.equal((await request('/api/session', undefined, { cookie: first })).status, 401);
  time += 8 * 60 * 60 * 1000;
  assert.equal((await request('/api/session', undefined, { cookie: second })).status, 401);
});

test('HTTPS configuration sets Secure and host-scoped cookie', async t => {
  const { request } = await start(t, { secure: true });
  const response = await request('/api/login', account);
  assert.match(response.headers.get('set-cookie'), /^__Host-scopeshield=/);
  assert.match(response.headers.get('set-cookie'), /; Secure/);
  assert.equal(response.headers.get('strict-transport-security'), 'max-age=31536000');
});

test('same-origin JSON is required even for login/logout; host spoofing fails', async t => {
  const { request, base } = await start(t);
  for (const path of ['/api/signup', '/api/login', '/api/logout', '/api/analyze', '/api/proposals/test/checkout', '/api/proposals/test/capture', '/api/proposals/test/status', '/api/proposals/test/delete']) {
    for (const origin of ['', 'null', 'https://attacker.example']) {
      assert.equal((await request(path, {}, { headers: { Origin: origin } })).status, 403);
    }
    assert.equal((await request(path, {}, { headers: { 'Sec-Fetch-Site': 'cross-site' } })).status, 403);
  }
  assert.equal((await request('/api/login', {}, { headers: { 'Content-Type': 'text/plain' } })).status, 415);
  // fetch owns the Host header, so use HTTP directly to exercise a forged host.
  const forgedStatus = await new Promise((resolve, reject) => {
    const request = httpRequest(base, { headers: { Host: 'attacker.example' } }, response => {
      response.resume();
      resolve(response.statusCode);
    });
    request.on('error', reject);
    request.end();
  });
  assert.equal(forgedStatus, 400);
  assert.equal((await request('/api/login', account, { headers: { 'X-Forwarded-Host': 'attacker.example' } })).status, 200);
});

test('headers and static allowlist protect environment, plans, database, source and Git', async t => {
  const { request } = await start(t);
  const home = await request('/');
  assert.equal(home.status, 200);
  assert.match(await home.text(), /ScopeShield/);
  assert.equal(home.headers.get('cache-control'), 'no-store');
  assert.equal(home.headers.get('referrer-policy'), 'no-referrer');
  assert.equal(home.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(home.headers.get('x-frame-options'), 'DENY');
  assert.match(home.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  assert.equal(home.headers.get('x-powered-by'), null);
  for (const path of ['/.env', '/.env.example', '/.git/config', '/src/server.js', '/devpost/spec.md', '/data/scopeshield.sqlite', '/package.json']) {
    const response = await request(path);
    assert.equal(response.status, 404, path);
    assert.ok(!(await response.text()).includes('server-private-test-key'));
  }
});

test('login and analysis throttles limit expensive or credential-guessing requests', async t => {
  const { request, login } = await start(t);
  const cookie = await login();
  for (let i = 0; i < 9; i++) assert.equal((await request('/api/login', { ...account, password: 'wrong test passphrase' })).status, 401);
  const limited = await request('/api/login', account);
  assert.equal(limited.status, 429);
  assert.ok(Number(limited.headers.get('retry-after')) > 0);
  for (let i = 0; i < 30; i++) assert.equal((await request('/api/analyze', input, { cookie })).status, 200);
  assert.equal((await request('/api/analyze', input, { cookie })).status, 429);
});

test('oversized bodies and invalid input are rejected before provider calls', async t => {
  let calls = 0;
  const { request, login } = await start(t, { fetchApi: async () => { calls++; return reply(); } });
  const cookie = await login();
  assert.equal((await request('/api/analyze', { ...input, agreement: 'x'.repeat(70000) }, { cookie })).status, 413);
  assert.equal((await request('/api/analyze', { ...input, agreement: '' }, { cookie })).status, 400);
  assert.equal((await request('/api/analyze', [], { cookie })).status, 400);
  assert.equal(calls, 0);
});

test('provider failures do not leak secrets or upstream error payloads', async t => {
  const { request, login } = await start(t, { fetchApi: async () => new Response('sensitive upstream data', { status: 500 }) });
  const response = await request('/api/analyze', input, { cookie: await login() });
  assert.equal(response.status, 502);
  const text = await response.text();
  assert.ok(!text.includes('sensitive upstream data'));
  assert.ok(!text.includes(password));
  assert.ok(!text.includes('server-private-test-key'));
});

test('logout during an analysis prevents late response from exposing the result', async t => {
  let release;
  let entered;
  const pending = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { entered = resolve; });
  const { request, login } = await start(t, { fetchApi: async () => { entered(); await pending; return reply(); } });
  const cookie = await login();
  const analysis = request('/api/analyze', input, { cookie });
  await started;
  await request('/api/logout', {}, { cookie });
  release();
  assert.equal((await analysis).status, 401);
});

test('server restart invalidates sessions', async t => {
  const first = await start(t);
  const cookie = await first.login();
  const second = await start(t);
  assert.equal((await second.request('/api/session', undefined, { cookie })).status, 401);
});

test('only a signed-in freelancer can publish/list; client sees immutable approved fields', async t => {
  const { request, login } = await start(t);
  const terms = { title: '<script>Store</script>', work: 'Add a store', delivery: 'Five extra days', amount: '250.00', reviewed: true,
    agreement: 'private agreement text', analysis: 'internal reasoning', amountCents: 1, currency: 'EUR' };
  assert.equal((await request('/api/proposals')).status, 401);
  assert.equal((await request('/api/proposals', terms)).status, 401);
  const cookie = await login();
  assert.equal((await request('/api/proposals', { ...terms, reviewed: false }, { cookie })).status, 400);
  const published = await request('/api/proposals', terms, { cookie });
  assert.equal(published.status, 201);
  const proposal = await published.json();
  assert.equal(proposal.amountCents, 25000);
  assert.equal(proposal.currency, 'USD');
  assert.match(proposal.token, /^[a-f0-9]{64}$/);
  const client = await request(`/api/proposals/${proposal.token}`);
  assert.equal(client.status, 200);
  const publicView = await client.json();
  assert.equal(publicView.work, terms.work);
  assert.equal(publicView.title, terms.title);
  assert.equal(publicView.status, 'unpaid');
  for (const field of ['id', 'token', 'agreement', 'analysis', 'owner_key', 'order_id', 'create_request_id']) assert.ok(!Object.hasOwn(publicView, field));
  assert.equal((await request(`/p/${proposal.token}`)).status, 200);
  assert.equal((await request(`/api/proposals/${proposal.token}`, { amount: '1.00' }, { method: 'PATCH', cookie })).status, 404);
  assert.equal((await (await request(`/api/proposals/${proposal.token}`)).json()).amountCents, 25000);
  assert.equal((await (await request('/api/proposals', undefined, { cookie })).json()).length, 1);
  for (const invalid of ['bad', 'a'.repeat(64)]) {
    assert.equal((await request(`/api/proposals/${invalid}`)).status, 404);
    assert.equal((await request(`/p/${invalid}`)).status, 404);
  }
});

test('published client link survives app/store reopen and owner logout', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'scopeshield-api-'));
  const path = join(directory, 'proposals.sqlite');
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  let token;
  await t.test('publish', async t => {
    const { request, login } = await start(t, { store: openStore(path) });
    const cookie = await login();
    const response = await request('/api/proposals', { reviewed: true, title: 'Store', work: 'Ten products', amount: '250', delivery: 'Five days' }, { cookie });
    assert.equal(response.status, 201);
    token = (await response.json()).token;
    await request('/api/logout', {}, { cookie });
    assert.equal((await request(`/api/proposals/${token}`)).status, 200);
  });
  await t.test('reopen', async t => {
    const { request } = await start(t, { store: openStore(path) });
    const response = await request(`/api/proposals/${token}`);
    assert.equal(response.status, 200);
    assert.equal((await response.json()).amountCents, 25000);
  });
});

test('only the proposal owner can delete; deleted proposals disappear and client/payment links stop working', async t => {
  let externalCalls = 0;
  const { request, login } = await start(t, { payments: true, fetchApi: async () => { externalCalls++; throw new Error('Unexpected provider call'); } });
  const cookie = await login();
  const saved = await request('/api/proposals', { reviewed: true, title: 'Store', work: 'Ten products', amount: '250', delivery: 'Five days' }, { cookie });
  const { token } = await saved.json();
  assert.equal((await request(`/api/proposals/${token}/delete`, {})).status, 401);
  assert.equal((await request(`/api/proposals/${token}/delete`, {}, { cookie, headers: { Origin: 'https://attacker.example' } })).status, 403);
  assert.equal((await request(`/api/proposals/${token}`)).status, 200);
  assert.equal((await request(`/api/proposals/${token}/delete`, {}, { cookie })).status, 200);
  assert.deepEqual(await (await request('/api/proposals', undefined, { cookie })).json(), []);
  assert.equal((await request(`/api/proposals/${token}`)).status, 404);
  assert.equal((await request(`/p/${token}`)).status, 404);
  for (const action of ['checkout', 'capture', 'status']) {
    assert.equal((await request(`/api/proposals/${token}/${action}`, { accepted: true })).status, 404);
  }
  assert.equal((await request(`/api/proposals/${token}/delete`, {}, { cookie })).status, 404);
  assert.equal(externalCalls, 0);
});

test('HTTP payment journey ignores browser amounts/order IDs and records payment for owner and client', async t => {
  let order;
  let captures = 0;
  const { request, login } = await start(t, { payments: true, fetchApi: async (url, options) => {
    if (url.endsWith('/v1/oauth2/token')) return new Response(JSON.stringify({ access_token: 'token', expires_in: 3600 }));
    if (url.endsWith('/v2/checkout/orders') && options.method === 'POST') {
      order = { id: 'HTTPORDER12345678', status: 'PAYER_ACTION_REQUIRED',
        purchase_units: [{ ...JSON.parse(options.body).purchase_units[0], payee: { merchant_id: 'HTTPMERCHANT1234' } }],
        links: [{ rel: 'payer-action', href: 'https://www.sandbox.paypal.com/checkoutnow?token=HTTPORDER12345678' }] };
    } else if (url.endsWith('/capture')) {
      captures++;
      assert.equal(order.status, 'APPROVED');
      order.status = 'COMPLETED';
      order.purchase_units[0].payments = { captures: [{ id: 'HTTPCAPTURE123456', status: 'COMPLETED', amount: { currency_code: 'USD', value: '250.00' } }] };
    } else assert.ok(url.endsWith(`/v2/checkout/orders/${order.id}`));
    return new Response(JSON.stringify(order));
  } });
  const cookie = await login();
  const published = await request('/api/proposals', { title: 'Store', work: 'Ten products', delivery: 'Five days', amount: '250', reviewed: true }, { cookie });
  const { token } = await published.json();
  assert.equal((await request(`/api/proposals/${token}/capture`, {})).status, 409);
  assert.equal((await request(`/api/proposals/${token}/checkout`, { accepted: false })).status, 400);
  const checkout = await request(`/api/proposals/${token}/checkout`, { accepted: true, amount: '0.01', currency: 'EUR', orderId: 'FAKE' });
  assert.equal(checkout.status, 200);
  assert.equal((await checkout.json()).proposal.amountCents, 25000);
  assert.equal(order.purchase_units[0].amount.value, '250.00');
  assert.equal((await request(`/api/proposals/${token}/capture?token=FAKE`, { orderId: 'FAKE' })).status, 409);
  order.status = 'APPROVED';
  const captured = await request(`/api/proposals/${token}/capture?token=FAKE`, { orderId: 'FAKE', amount: '0.01' });
  assert.equal(captured.status, 200);
  assert.equal((await captured.json()).status, 'paid');
  assert.equal((await request(`/api/proposals/${token}/capture`, {})).status, 200);
  assert.equal(captures, 1);
  assert.equal((await (await request(`/api/proposals/${token}`)).json()).status, 'paid');
  assert.equal((await (await request('/api/proposals', undefined, { cookie })).json())[0].status, 'paid');
});

test('browser code uses safe text sinks and no persistent credential/data storage', async () => {
  for (const [script, page] of [['owner.js', 'workspace.html'], ['proposal.js', 'proposal.html'], ['auth.js', 'login.html']]) {
    const source = await readFile(new URL(`../public/${script}`, import.meta.url), 'utf8');
    assert.doesNotMatch(source, /localStorage|sessionStorage|innerHTML|outerHTML|insertAdjacentHTML|document\.write/);
    assert.doesNotMatch(source, /GROQ_API_KEY|PAYPAL_CLIENT_SECRET|OWNER_ACCESS_KEY/);
    const html = await readFile(new URL(`../public/${page}`, import.meta.url), 'utf8');
    const requiredIds = [...source.matchAll(/\$\('([^']+)'\)/g)].map(match => match[1]);
    for (const id of requiredIds) assert.ok(html.includes(`id="${id}"`), `Missing UI element: ${id}`);
  }
});

test('signup creates a private account; another account cannot list/delete its proposals or claim legacy data', async t => {
  const { request, login, store } = await start(t);
  const legacy = store.create({ title: 'Old proposal', work: 'Preserved', delivery: 'Later', amountCents: 100 });
  const firstCookie = await login();
  const created = await request('/api/proposals', { reviewed: true, title: 'Private workspace', work: 'Extra work', amount: '250', delivery: 'Five days', ownerId: 'forged' }, { cookie: firstCookie });
  const proposal = await created.json();
  const signup = await request('/api/signup', { email: ' New@Example.test ', name: 'New Freelancer', password });
  assert.equal(signup.status, 201);
  assert.deepEqual(await signup.json(), { user: { email: 'new@example.test', name: 'New Freelancer' } });
  const secondCookie = signup.headers.get('set-cookie').split(';')[0];
  assert.deepEqual(await (await request('/api/proposals', undefined, { cookie: secondCookie })).json(), []);
  assert.equal((await request(`/api/proposals/${proposal.token}/delete`, {}, { cookie: secondCookie })).status, 404);
  assert.equal((await request(`/api/proposals/${legacy.token}/delete`, {}, { cookie: secondCookie })).status, 404);
  assert.equal((await request(`/api/proposals/${proposal.token}`)).status, 200);
  assert.equal((await request(`/api/proposals/${legacy.token}`)).status, 200);
  assert.equal((await request('/api/signup', { email: 'NEW@example.test', name: 'Duplicate', password })).status, 409);
  const user = store.userByEmail('new@example.test');
  assert.ok(!user.password_hash.includes(password));
  assert.equal(store.get(proposal.token).owner_id, store.userByEmail(account.email).id);
  assert.equal(store.get(legacy.token).owner_id, null);
  assert.equal((await request('/api/login', { email: 'new@example.test', password })).status, 200);
  const session = await (await request('/api/session', undefined, { cookie: secondCookie })).json();
  assert.equal(session.user.email, 'new@example.test');
  assert.ok(!JSON.stringify(session).includes('password_hash'));
});

test('landing, auth pages and protected workspace are reachable; signup validates and throttles', async t => {
  const { request, login } = await start(t);
  for (const path of ['/', '/login', '/signup']) assert.equal((await request(path)).status, 200);
  const protectedPage = await request('/app', undefined, { redirect: 'manual' });
  assert.equal(protectedPage.status, 302);
  assert.equal(protectedPage.headers.get('location'), '/login');
  assert.equal((await request('/app', undefined, { cookie: await login() })).status, 200);
  for (let index = 0; index < 5; index++) assert.equal((await request('/api/signup', { email: 'invalid', password: 'short' })).status, 400);
  assert.equal((await request('/api/signup', { name: 'Test', email: 'new@example.test', password })).status, 429);
});

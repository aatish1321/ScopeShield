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

const ownerKey = 'synthetic-owner-test-key-at-least-32-characters';
const input = { agreement: 'Build three pages.', newRequest: 'Add a store.' };
const result = {
  classification: 'additional', summary: '<img src=x onerror=alert(1)>',
  items: [{ requestExcerpt: 'store', agreementExcerpt: 'three pages', explanation: 'Potential extra work.', suggestedWork: '<script>sample</script>' }],
};
const reply = () => new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(result) } }] }));

async function start(t, options = {}) {
  const config = loadConfig({ GROQ_API_KEY: 'server-private-test-key', OWNER_ACCESS_KEY: ownerKey,
    APP_URL: options.secure ? 'https://127.0.0.1' : 'http://127.0.0.1' });
  const store = options.store || openStore(':memory:');
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
    const response = await request('/api/login', { key: ownerKey });
    assert.equal(response.status, 200);
    return response.headers.get('set-cookie').split(';')[0];
  };
  return { request, login, base, config };
}

test('anonymous APIs fail closed; valid login grants analysis; logout revokes session', async t => {
  const { request, login } = await start(t);
  assert.equal((await request('/api/session')).status, 401);
  assert.equal((await request('/api/analyze', input)).status, 401);
  assert.equal((await request('/api/login', { key: 'wrong' })).status, 401);
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
  const response = await request('/api/login', { key: ownerKey }, { cookie: first });
  const rawCookie = response.headers.get('set-cookie');
  assert.match(rawCookie, /HttpOnly/);
  assert.match(rawCookie, /SameSite=Strict/);
  assert.match(rawCookie, /Path=\//);
  assert.ok(!rawCookie.includes(ownerKey));
  const second = rawCookie.split(';')[0];
  assert.notEqual(first, second);
  assert.equal((await request('/api/session', undefined, { cookie: first })).status, 401);
  time += 8 * 60 * 60 * 1000;
  assert.equal((await request('/api/session', undefined, { cookie: second })).status, 401);
});

test('HTTPS configuration sets Secure and host-scoped cookie', async t => {
  const { request } = await start(t, { secure: true });
  const response = await request('/api/login', { key: ownerKey });
  assert.match(response.headers.get('set-cookie'), /^__Host-scopeshield=/);
  assert.match(response.headers.get('set-cookie'), /; Secure/);
  assert.equal(response.headers.get('strict-transport-security'), 'max-age=31536000');
});

test('same-origin JSON is required even for login/logout; host spoofing fails', async t => {
  const { request, base } = await start(t);
  for (const path of ['/api/login', '/api/logout', '/api/analyze']) {
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
  assert.equal((await request('/api/login', { key: ownerKey }, { headers: { 'X-Forwarded-Host': 'attacker.example' } })).status, 200);
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
  for (let i = 0; i < 9; i++) assert.equal((await request('/api/login', { key: 'wrong' })).status, 401);
  const limited = await request('/api/login', { key: ownerKey });
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
  assert.ok(!text.includes(ownerKey));
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

test('only owner can publish/list; client sees immutable approved fields', async t => {
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

test('browser code uses safe text sinks and no persistent credential/data storage', async () => {
  for (const [script, page] of [['owner.js', 'index.html'], ['proposal.js', 'proposal.html']]) {
    const source = await readFile(new URL(`../public/${script}`, import.meta.url), 'utf8');
    assert.doesNotMatch(source, /localStorage|sessionStorage|innerHTML|outerHTML|insertAdjacentHTML|document\.write/);
    assert.doesNotMatch(source, /GROQ_API_KEY|PAYPAL_CLIENT_SECRET|OWNER_ACCESS_KEY/);
    const html = await readFile(new URL(`../public/${page}`, import.meta.url), 'utf8');
    const requiredIds = [...source.matchAll(/\$\('([^']+)'\)/g)].map(match => match[1]);
    for (const id of requiredIds) assert.ok(html.includes(`id="${id}"`), `Missing UI element: ${id}`);
  }
});

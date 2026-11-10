import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openStore, publicProposal } from '../src/store.js';

test('approved proposals persist with private permissions and immutable terms', t => {
  const directory = mkdtempSync(join(tmpdir(), 'scopeshield-store-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'proposals.sqlite');
  const first = openStore(path);
  const row = first.create({ title: 'Store', work: "Ten products; DROP TABLE proposals; --", delivery: 'Five days', amountCents: 25000 });
  assert.match(row.token, /^[a-f0-9]{64}$/);
  assert.equal(first.get('invalid'), undefined);
  assert.equal(first.get('a'.repeat(64)), undefined);
  first.close();
  assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.equal(statSync(directory).mode & 0o777, 0o700);
  const second = openStore(path);
  assert.equal(second.get(row.token).work, "Ten products; DROP TABLE proposals; --");
  assert.equal(second.list().length, 1);
  second.close();
  const db = new DatabaseSync(path);
  assert.throws(() => db.prepare('UPDATE proposals SET amount_cents = ? WHERE token = ?').run(1, row.token), /cannot be changed/);
  db.close();
});

test('public views expose only approved terms and payment status', () => {
  const store = openStore(':memory:');
  try {
    const row = store.create({ title: '<script>test</script>', work: 'Store', delivery: 'Five days', amountCents: 1 });
    const value = publicProposal({ ...row, agreement: 'private agreement', raw_request: 'private request', owner_key: 'secret' });
    assert.deepEqual(Object.keys(value).sort(), ['title', 'work', 'delivery', 'amountCents', 'currency', 'createdAt', 'status', 'captureId', 'paidAt', 'originalScope', 'changeReason', 'originalAmountCents'].sort());
    assert.equal(value.amountCents, 1);
    assert.equal(value.currency, 'USD');
    assert.equal(value.status, 'unpaid');
    assert.ok(!JSON.stringify(value).includes('private agreement'));
  } finally { store.close(); }
});

test('deletion persists, hides the link, and retains payment records and fixed terms', t => {
  const directory = mkdtempSync(join(tmpdir(), 'scopeshield-delete-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'proposals.sqlite');
  const store = openStore(path);
  const row = store.create({ title: 'Store', work: 'Ten products', delivery: 'Five days', amountCents: 25000 });
  store.updatePayment(row.token, { payment_status: 'paid', capture_id: 'CAPTURE12345678901', order_id: 'ORDER12345678901' });
  store.remove(row.token);
  assert.equal(store.get(row.token), undefined);
  assert.equal(store.list().length, 0);
  assert.equal(store.updatePayment(row.token, { payment_status: 'unpaid' }), undefined);
  store.close();
  const reopened = openStore(path);
  assert.equal(reopened.get(row.token), undefined);
  assert.equal(reopened.list().length, 0);
  reopened.close();
  const db = new DatabaseSync(path);
  const retained = db.prepare('SELECT * FROM proposals WHERE token = ?').get(row.token);
  assert.ok(retained.deleted_at);
  assert.equal(retained.payment_status, 'paid');
  assert.equal(retained.capture_id, 'CAPTURE12345678901');
  assert.equal(retained.order_id, 'ORDER12345678901');
  assert.equal(retained.amount_cents, 25000);
  assert.equal(retained.work, 'Ten products');
  db.close();
});

test('accounts and ownership persist; only explicit local assignment links legacy records', t => {
  const directory = mkdtempSync(join(tmpdir(), 'scopeshield-accounts-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'accounts.sqlite');
  const first = openStore(path);
  const legacy = first.create({ title: 'Preserve me', work: 'Terms', delivery: 'Later', amountCents: 100 });
  const user = first.createUser({ name: 'Test', email: 'test@example.test', passwordHash: 'synthetic hash' });
  assert.equal(first.list(user.id).length, 0);
  first.close();
  const second = openStore(path);
  assert.equal(second.userByEmail('test@example.test').id, user.id);
  assert.equal(second.get(legacy.token).owner_id, null);
  assert.throws(() => second.assignLegacy('nonexistent-user'), /FOREIGN KEY/);
  assert.equal(second.assignLegacy(user.id), 1);
  assert.equal(second.list(user.id).length, 1);
  assert.equal(second.list().length, 0);
  assert.equal(second.get(legacy.token).amount_cents, 100);
  second.close();
});

test('reviewed change context persists, cannot be edited, and older proposals migrate without invented terms', t => {
  const directory = mkdtempSync(join(tmpdir(), 'scopeshield-change-order-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'proposals.sqlite');
  const first = openStore(path);
  const old = first.create({ title: 'Legacy', work: 'Extra work', delivery: 'Five days', amountCents: 25000 });
  first.updatePayment(old.token, { order_id: 'ORDER12345678', payment_status: 'ready' });
  first.close();
  const legacyDb = new DatabaseSync(path);
  legacyDb.exec(`DROP TRIGGER fixed_change_context;
    ALTER TABLE proposals DROP COLUMN original_scope;
    ALTER TABLE proposals DROP COLUMN change_reason;
    ALTER TABLE proposals DROP COLUMN original_amount_cents;`);
  legacyDb.close();
  const migrated = openStore(path);
  const preserved = migrated.get(old.token);
  assert.equal(preserved.original_scope, '');
  assert.equal(preserved.change_reason, '');
  assert.equal(preserved.original_amount_cents, null);
  assert.equal(preserved.amount_cents, 25000);
  assert.equal(preserved.order_id, 'ORDER12345678');
  assert.equal(preserved.payment_status, 'ready');
  const row = migrated.create({ title: 'Store', work: 'Ten products', delivery: 'Five days', amountCents: 25000,
    originalScope: 'Three pages', changeReason: 'Adds product data, checkout and testing.', originalAmountCents: 60000 });
  assert.throws(() => migrated.updatePayment(row.token, { original_scope: 'Altered' }), /Invalid payment update/);
  migrated.close();
  const reopened = openStore(path);
  assert.equal(publicProposal(reopened.get(row.token)).originalScope, 'Three pages');
  assert.equal(publicProposal(reopened.get(row.token)).originalAmountCents, 60000);
  reopened.close();
  const db = new DatabaseSync(path);
  for (const [column, value] of [['original_scope', 'Altered'], ['change_reason', 'Changed'], ['original_amount_cents', 1]]) {
    assert.throws(() => db.prepare(`UPDATE proposals SET ${column} = ? WHERE token = ?`).run(value, row.token), /cannot be changed/);
  }
  db.close();
});

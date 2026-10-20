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
    assert.deepEqual(Object.keys(value).sort(), ['title', 'work', 'delivery', 'amountCents', 'currency', 'createdAt', 'status', 'captureId', 'paidAt'].sort());
    assert.equal(value.amountCents, 1);
    assert.equal(value.currency, 'USD');
    assert.equal(value.status, 'unpaid');
    assert.ok(!JSON.stringify(value).includes('private agreement'));
  } finally { store.close(); }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { hashPassword, verifyPassword, credentials } from '../src/auth.js';

const password = 'a unique test passphrase for ScopeShield';
test('salted password hashes verify without storing the password', async () => {
  const first = await hashPassword(password);
  const second = await hashPassword(password);
  assert.notEqual(first, second);
  assert.ok(!first.includes(password));
  assert.equal(await verifyPassword(password, first), true);
  assert.equal(await verifyPassword('incorrect test passphrase', first), false);
  assert.equal(await verifyPassword(password, undefined), false);
});
test('account inputs are bounded and normalized without changing passwords', () => {
  assert.deepEqual(credentials({ email: ' Example@Example.test ', password, name: ' Test ' }, true), { email: 'example@example.test', password, name: 'Test' });
  for (const body of [null, {}, { email: 'invalid', password }, { email: 'x@y.test', password: 'short' },
    { email: 'x@y.test', password: 'a'.repeat(129) }, { email: 'x@y.test', password, name: '' }]) {
    assert.throws(() => credentials(body, true), { status: 400 });
  }
});

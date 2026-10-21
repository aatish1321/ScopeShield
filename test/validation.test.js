import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig, requiredText, parseAmount, validateProposal } from '../src/validation.js';

const env = { GROQ_API_KEY: 'test-provider-key' };

test('configuration defaults to loopback and Groq strict-output model', () => {
  const config = loadConfig(env);
  assert.equal(config.appUrl.origin, 'http://localhost:3000');
  assert.equal(config.groqModel, 'openai/gpt-oss-20b');
  assert.equal(config.port, 3000);
});

test('missing or weak credentials fail closed without echoing values', () => {
  assert.throws(() => loadConfig({}), /GROQ_API_KEY/);
  assert.throws(() => loadConfig({ GROQ_API_KEY: '   ' }), /GROQ_API_KEY/);
});

test('only configured origins and safe local HTTP are allowed', () => {
  for (const url of ['invalid', 'http://example.com', 'https://example.com/path', 'https://user:pass@example.com',
    'https://example.com/?secret=x', 'https://example.com/#x', 'ftp://localhost']) {
    assert.throws(() => loadConfig({ ...env, APP_URL: url }), /APP_URL/);
  }
  assert.throws(() => loadConfig({ ...env, NODE_ENV: 'production' }), /HTTPS/);
  assert.equal(loadConfig({ ...env, APP_URL: 'https://example.com', NODE_ENV: 'production' }).appUrl.protocol, 'https:');
  for (const port of ['0', '65536', 'text', '3.5']) assert.throws(() => loadConfig({ ...env, PORT: port }), /PORT/);
});

test('bounded text validates types, emptiness and size', () => {
  assert.equal(requiredText(' hello ', 'Text', 10), 'hello');
  for (const value of [null, undefined, [], {}, 3, '', '  ', 'x'.repeat(11)]) {
    assert.throws(() => requiredText(value, 'Text', 10), /Text must contain/);
  }
});

test('USD money parsing is exact and rejects ambiguous or out-of-range amounts', () => {
  for (const [text, cents] of [['0.01', 1], ['0.1', 10], ['250', 25000], [' 250.00 ', 25000], ['999999.99', 99999999]]) {
    assert.equal(parseAmount(text), cents);
  }
  for (const value of ['0', '0.00', '-1', '1.001', '1e3', '$250', '1,000', '01', '.5', '1.', 'NaN', '1000000', '', null, 1]) {
    assert.throws(() => parseAmount(value), { status: 400 });
  }
});

test('publication requires human review and bounded, explicit terms', () => {
  const body = { reviewed: true, title: 'Store', work: 'Ten products', delivery: 'Five days', amount: '250.00' };
  assert.deepEqual(validateProposal(body), { title: 'Store', work: 'Ten products', delivery: 'Five days', amountCents: 25000 });
  for (const invalid of [{ ...body, reviewed: false }, { ...body, reviewed: 'true' }, { ...body, work: '' }, { ...body, amount: '0' }]) {
    assert.throws(() => validateProposal(invalid), { status: 400 });
  }
});

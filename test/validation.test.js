import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig, requiredText } from '../src/validation.js';

const env = { GROQ_API_KEY: 'test-provider-key', OWNER_ACCESS_KEY: 'test-owner-key-of-at-least-32-characters' };

test('configuration defaults to loopback and Groq strict-output model', () => {
  const config = loadConfig(env);
  assert.equal(config.appUrl.origin, 'http://localhost:3000');
  assert.equal(config.groqModel, 'openai/gpt-oss-20b');
  assert.equal(config.port, 3000);
});

test('missing or weak credentials fail closed without echoing values', () => {
  assert.throws(() => loadConfig({}), /GROQ_API_KEY/);
  for (const ownerKey of ['', 'short', ' '.repeat(64)]) {
    assert.throws(() => loadConfig({ ...env, OWNER_ACCESS_KEY: ownerKey }), /OWNER_ACCESS_KEY/);
  }
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

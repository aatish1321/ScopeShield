import test from 'node:test';
import assert from 'node:assert/strict';
import { compareRequest, validateComparison } from '../src/analysis.js';

const agreement = 'Build a three-page website with a contact form.';
const newRequest = 'Add a ten-product store.';
const config = { groqKey: 'private-test-key', groqModel: 'openai/gpt-oss-20b' };
const comparison = {
  classification: 'additional', summary: 'The store appears to add work beyond the specified pages.',
  items: [{ requestExcerpt: 'ten-product store', agreementExcerpt: 'three-page website',
    explanation: 'A store introduces product and checkout work; confirm this interpretation.', suggestedWork: 'Add a ten-product store.' }],
};
const success = value => new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(value) } }] }));

test('Groq receives server auth, untrusted documents and strict schema', async () => {
  let called = false;
  const result = await compareRequest({ agreement, newRequest }, config, async (url, options) => {
    called = true;
    assert.equal(url, 'https://api.groq.com/openai/v1/chat/completions');
    assert.equal(options.headers.Authorization, `Bearer ${config.groqKey}`);
    const body = JSON.parse(options.body);
    assert.deepEqual(JSON.parse(body.messages[1].content), { agreement, newRequest });
    assert.equal(body.messages[0].role, 'system');
    assert.equal(body.response_format.json_schema.strict, true);
    assert.equal(body.response_format.json_schema.schema.additionalProperties, false);
    assert.equal(body.stream, false);
    assert.ok(options.signal instanceof AbortSignal);
    return success(comparison);
  });
  assert.ok(called);
  assert.deepEqual(result, comparison);
});

test('invalid input never reaches Groq', async () => {
  let called = false;
  await assert.rejects(compareRequest({ agreement: '', newRequest }, config, async () => { called = true; }), { status: 400 });
  assert.equal(called, false);
});

test('included and unclear results remain distinct, and missing agreement evidence is allowed', () => {
  for (const classification of ['included', 'unclear']) {
    assert.equal(validateComparison({ classification, summary: 'Needs human review.', items: [] }, agreement, newRequest).classification, classification);
  }
  const value = structuredClone(comparison);
  value.items[0].agreementExcerpt = null;
  assert.deepEqual(validateComparison(value, agreement, newRequest), value);
});

test('schema/evidence validation rejects hallucinated quotes and unusable shapes', () => {
  const badValues = [null, [], {}, { ...comparison, unexpected: true }, { ...comparison, classification: 'certain' },
    { ...comparison, summary: '' }, { ...comparison, items: [] }, { ...comparison, classification: 'included' },
    { ...comparison, items: Array(13).fill(comparison.items[0]) },
    { ...comparison, items: [{ ...comparison.items[0], agreementExcerpt: 'invented evidence' }] },
    { ...comparison, items: [{ ...comparison.items[0], requestExcerpt: 'invented request' }] },
    { ...comparison, items: [{ ...comparison.items[0], suggestedWork: '<'.repeat(3001) }] }];
  for (const value of badValues) assert.throws(() => validateComparison(value, agreement, newRequest), { status: 502 });
});

test('evidence tolerates line wrapping and repeated whitespace without changing words', () => {
  const value = structuredClone(comparison);
  value.items[0].requestExcerpt = 'ten-product\t store';
  value.items[0].agreementExcerpt = 'three-page website';
  assert.deepEqual(validateComparison(value, 'Build a three-page\nwebsite with a contact form.', 'Add a ten-product\n  store.'), value);
  value.items[0].requestExcerpt = 'product management';
  assert.throws(() => validateComparison(value, agreement, 'I want to manage the products myself.'), { status: 502 });
  value.items[0].requestExcerpt = 'ten product store';
  assert.throws(() => validateComparison(value, agreement, newRequest), { status: 502 });
});

test('invalid evidence triggers exactly one corrective attempt', async () => {
  const invalid = structuredClone(comparison);
  invalid.items[0].requestExcerpt = 'product management';
  let calls = 0;
  const result = await compareRequest({ agreement, newRequest }, config, async (url, options) => {
    calls++;
    if (calls === 2) assert.match(JSON.parse(options.body).messages[0].content, /previous attempt failed source-quote validation/);
    return success(calls === 1 ? invalid : comparison);
  });
  assert.equal(calls, 2);
  assert.deepEqual(result, comparison);
});

test('repeated fabricated evidence fails closed after two attempts', async () => {
  let calls = 0;
  const invalid = structuredClone(comparison);
  invalid.items[0].agreementExcerpt = 'The client agreed to unlimited charges.';
  await assert.rejects(compareRequest({ agreement, newRequest }, config, async () => {
    calls++;
    return success(invalid);
  }), { status: 502, code: 'INVALID_EVIDENCE' });
  assert.equal(calls, 2);
});

test('provider errors are useful without disclosing upstream bodies or credentials', async () => {
  for (const status of [400, 401, 403, 429, 500]) {
    await assert.rejects(compareRequest({ agreement, newRequest }, config,
      async () => new Response(`upstream secret ${config.groqKey}`, { status })), error => {
      assert.equal(error.status, status === 429 ? 429 : 502);
      assert.ok(!error.message.includes(config.groqKey));
      assert.ok(!error.message.includes('upstream secret'));
      return true;
    });
  }
});

test('refusal, truncation, malformed JSON, transport failure and timeout fail safely', async () => {
  const badReplies = [
    { choices: [{ finish_reason: 'length', message: { content: '{}' } }] },
    { choices: [{ finish_reason: 'stop', message: { refusal: 'refused', content: '{}' } }] },
    { choices: [{ finish_reason: 'stop', message: { content: 'not json' } }] },
    { choices: [] },
  ];
  for (const reply of badReplies) await assert.rejects(compareRequest({ agreement, newRequest }, config,
    async () => new Response(JSON.stringify(reply))), { status: 502 });
  await assert.rejects(compareRequest({ agreement, newRequest }, config,
    async () => { throw new Error('upstream secret'); }), { status: 502 });
  await assert.rejects(compareRequest({ agreement, newRequest }, config,
    async () => { throw new DOMException('timed out', 'TimeoutError'); }), { status: 504 });
});

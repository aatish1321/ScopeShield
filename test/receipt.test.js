import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';

test('receipt separates project value from the additional charge and labels paid/legacy states honestly', async () => {
  const source = await readFile(new URL('../public/proposal.js', import.meta.url), 'utf8');
  const elements = new Map([...source.matchAll(/\$\('([^']+)'\)/g)].map(([, id]) => [id, { textContent: '', hidden: false, addEventListener() {} }]));
  const context = { document: { getElementById: id => elements.get(id) }, window: { location: { pathname: `/p/${'a'.repeat(64)}` } } };
  runInNewContext(source.slice(0, source.indexOf('start().catch')), context);
  const proposal = { title: 'Store', work: '<img src=x onerror=alert(1)>', delivery: 'Five extra days',
    originalScope: 'Three-page website', changeReason: 'Catalog, payment integration and testing.', originalAmountCents: 60000,
    amountCents: 25000, currency: 'USD', createdAt: '2026-11-05T10:00:00Z', status: 'unpaid', captureId: null, checkoutAvailable: true };
  context.render(proposal);
  assert.equal(elements.get('amount').textContent, '$250.00 USD');
  assert.equal(elements.get('project-total').textContent, '$850.00 USD');
  assert.equal(elements.get('original-cost').textContent, '$600.00 USD');
  assert.equal(elements.get('original-scope').textContent, proposal.originalScope);
  assert.equal(elements.get('change-reason').textContent, proposal.changeReason);
  assert.equal(elements.get('work').textContent, proposal.work);
  assert.match(elements.get('document-kind').textContent, /NOT A PAYMENT RECEIPT/);
  assert.equal(elements.get('receipt').hidden, true);
  assert.equal(elements.get('checkout-form').hidden, false);
  context.render({ ...proposal, status: 'paid', captureId: 'CAPTURE12345678' });
  assert.match(elements.get('document-kind').textContent, /SANDBOX PAYMENT RECEIPT/);
  assert.equal(elements.get('amount-label').textContent, 'Paid for this change');
  assert.equal(elements.get('checkout-form').hidden, true);
  assert.match(elements.get('receipt').textContent, /CAPTURE12345678/);
  context.render({ ...proposal, originalScope: '', changeReason: '', originalAmountCents: null, status: 'pending' });
  assert.equal(elements.get('original-cost-row').hidden, true);
  assert.equal(elements.get('project-total-row').hidden, true);
  assert.equal(elements.get('project-total').textContent, '');
  assert.match(elements.get('original-scope').textContent, /not recorded/);
  assert.match(elements.get('change-reason').textContent, /not recorded/);
  assert.match(elements.get('document-kind').textContent, /NOT A PAYMENT RECEIPT/);
});

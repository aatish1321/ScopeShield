import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { dashboardMetrics } from '../public/dashboard.js';

class Element {
  constructor(tag = 'div') { this.tag = tag; this.children = []; this.attributes = {}; this.textContent = ''; }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = children; }
  setAttribute(name, value) { this.attributes[name] = value; }
  addEventListener() {}
  set href(value) { this.url = new URL(value, 'http://localhost:3000').href; }
  get href() { return this.url; }
}

async function workspace(proposals) {
  const source = await readFile(new URL('../public/owner.js', import.meta.url), 'utf8');
  const elements = new Map([...source.matchAll(/\$\('([^']+)'\)/g)].map(([, id]) => [id, new Element()]));
  const document = {
    getElementById: id => elements.get(id),
    createElement: tag => new Element(tag),
    createTextNode: text => Object.assign(new Element('text'), { textContent: text }),
    createElementNS: (namespaceURI, tag) => Object.assign(new Element(tag), { namespaceURI }),
  };
  const context = { document, dashboardMetrics, URL, fetch: async path => {
    assert.equal(path, '/api/proposals');
    return { ok: true, json: async () => proposals };
  } };
  const code = source.slice(0, source.lastIndexOf("api('/api/session')")).replace(/^import[^\n]+\n/, '');
  runInNewContext(code, context);
  await runInNewContext('signedIn = true; refreshProposals()', context);
  return elements;
}

test('proposal covers display actual fees and dates while keeping user text as text', async () => {
  const proposal = { token: 'a'.repeat(64), title: '<img src=x>', work: 'Add a product catalog and checkout.',
    amountCents: 25000, originalAmountCents: 60000, status: 'unpaid', createdAt: '2026-11-09T10:00:00Z', paidAt: null, captureId: null };
  const elements = await workspace([proposal]);
  const [card] = elements.get('proposals').children;
  const [cover, title, work] = card.children;
  assert.equal(cover.className, 'proposal-cover');
  assert.equal(cover.children[1].textContent, '$250.00 USD');
  assert.equal(cover.children[2].textContent, 'Nov 9, 2026');
  assert.equal(title.textContent, proposal.title);
  assert.equal(work.textContent, proposal.work);
  assert.equal(elements.get('nav-proposal-count').textContent, '1');
});

test('an empty account shows an honest empty state instead of sample project cards', async () => {
  const elements = await workspace([]);
  const [empty] = elements.get('proposals').children;
  assert.equal(empty.className, 'dashboard-empty');
  assert.equal(empty.children[0].className, 'empty-document');
  assert.equal(elements.get('nav-proposal-count').textContent, '0');
  assert.equal(elements.get('total-count').textContent, '0');
});

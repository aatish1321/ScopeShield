import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dashboardMetrics } from '../public/dashboard.js';

const now = new Date('2026-11-05T17:00:00Z');
const proposal = (status, amountCents, createdAt, paidAt = null) => ({ status, amountCents, createdAt, paidAt });
test('dashboard totals use actual status, publication dates and confirmed payment dates', () => {
  const result = dashboardMetrics([
    proposal('paid', 25001, '2026-10-01T12:00:00Z', '2026-11-05T10:00:00Z'),
    proposal('paid', 100, '2026-11-05T00:00:00Z', '2026-09-01T00:00:00Z'),
    proposal('unpaid', 5000, '2026-11-04T23:59:59Z'),
    proposal('ready', 9000, '2026-10-30T00:00:00Z'),
    proposal('pending', 3000, '2026-11-06T00:00:00Z'),
    proposal('unknown', 4000, '2026-10-29T00:00:00Z'),
    proposal('failed', 2000, '2026-11-05T12:00:00Z'),
  ], now);
  assert.equal(result.total, 7);
  assert.deepEqual(result.groups, { paid: 2, awaiting: 2, processing: 2, failed: 1 });
  assert.equal(result.paidCents, 25101);
  assert.equal(result.openCents, 14000);
  assert.equal(result.paidRate, 29);
  assert.equal(result.activity[0].date, '2026-10-30');
  assert.deepEqual(result.activity.map(value => value.count), [1, 0, 0, 0, 0, 1, 2]);
  assert.equal(result.collections.length, 30);
  assert.equal(result.collections.at(-1), 25001);
  assert.equal(result.collections.at(-2), 0);
});
test('empty accounts have zero totals and no synthetic chart data', () => {
  const result = dashboardMetrics([], now);
  assert.equal(result.total, 0);
  assert.equal(result.paidRate, 0);
  assert.equal(result.openCents, 0);
  assert.equal(result.paidCents, 0);
  assert.ok(result.activity.every(value => value.count === 0));
  assert.ok(result.collections.every(value => value === 0));
});
test('collections accumulate integer cents across UTC month boundaries and exclude future payments', () => {
  const result = dashboardMetrics([
    proposal('paid', 1, '2026-10-01', '2026-10-07T00:00:00Z'),
    proposal('paid', 2, '2026-10-01', '2026-10-31T23:59:59Z'),
    proposal('paid', 3, '2026-10-01', '2026-11-06T00:00:00Z'),
    proposal('unpaid', 999, '2026-10-01', '2026-11-05T00:00:00Z'),
  ], now);
  assert.equal(result.collections[0], 1);
  assert.equal(result.collections.at(-1), 3);
});
test('dashboard preserves browser element bindings and avoids unsafe markup/storage sinks', async () => {
  const source = await readFile(new URL('../public/owner.js', import.meta.url), 'utf8');
  const html = await readFile(new URL('../public/workspace.html', import.meta.url), 'utf8');
  for (const [, id] of source.matchAll(/\$\('([^']+)'\)/g)) assert.ok(html.includes(`id="${id}"`), `Missing element: ${id}`);
  assert.doesNotMatch(source, /innerHTML|outerHTML|localStorage|sessionStorage|\.style\./);
  assert.match(html, /src="\/owner.js" type="module"/);
  assert.match(html, /href="\/dashboard.css"/);
  const ids = [...html.matchAll(/id="([^"]+)"/g)].map(match => match[1]);
  assert.equal(new Set(ids).size, ids.length);
});

test('landing links and assets exist, and previews are distinguished from app captures', async () => {
  const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
  const ids = new Set([...html.matchAll(/id="([^"]+)"/g)].map(match => match[1]));
  for (const [, anchor] of html.matchAll(/href="#([^"]+)"/g)) assert.ok(ids.has(anchor), `Broken landing anchor: ${anchor}`);
  for (const [, asset] of html.matchAll(/(?:src|href)="(\/(?:assets\/|[a-z]+\.css)[^"]*)"/g)) {
    await readFile(new URL(`../public${asset}`, import.meta.url));
  }
  assert.match(html, /Actual app screenshot/);
  assert.match(html, /Illustrative interface preview/);
  assert.match(html, /Not a payment receipt/);
});
test('glass presentation covers all screens and respects reduced motion without weakening CSP', async () => {
  for (const file of ['index.html', 'workspace.html', 'login.html', 'proposal.html']) {
    const html = await readFile(new URL(`../public/${file}`, import.meta.url), 'utf8');
    assert.match(html, /class="glass-theme/);
    assert.match(html, /href="\/glass.css"/);
  }
  const css = await readFile(new URL('../public/glass.css', import.meta.url), 'utf8');
  assert.match(css, /@keyframes ambient-gradient/);
  assert.match(css, /prefers-reduced-motion:reduce/);
  assert.match(css, /animation:none/);
  assert.doesNotMatch(css, /https?:|@import/);
});

test('Editorial cobalt palette keeps body, secondary, placeholder and action text readable', async () => {
  const css = await readFile(new URL('../public/glass.css', import.meta.url), 'utf8');
  const color = name => {
    const match = css.match(new RegExp(`--${name}:(#[a-f0-9]{6})`));
    assert.ok(match, `Missing theme token: ${name}`);
    return match[1];
  };
  const luminance = hex => {
    const channels = hex.slice(1).match(/../g).map(channel => parseInt(channel, 16) / 255)
      .map(value => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4);
    return channels[0] * .2126 + channels[1] * .7152 + channels[2] * .0722;
  };
  const contrast = (a, b) => {
    const values = [luminance(a), luminance(b)].sort((a, b) => b - a);
    return (values[0] + .05) / (values[1] + .05);
  };
  for (const name of ['text', 'secondary', 'quiet', 'accent']) {
    assert.ok(contrast(color(name), color('surface')) >= 4.5, `${name} text lacks contrast`);
  }
  assert.ok(contrast('#ffffff', color('action')) >= 4.5, 'Primary button text lacks contrast');
  assert.ok(contrast(color('input-border'), color('input-surface')) >= 3, 'Input boundary lacks contrast');
  assert.match(css, /color-scheme:light/);
  assert.match(css, /prefers-reduced-transparency:reduce/);
});

test('forest waves are local decorative SVG and stop with reduced motion', async () => {
  const css = await readFile(new URL('../public/glass.css', import.meta.url), 'utf8');
  const svg = await readFile(new URL('../public/assets/forest-waves.svg', import.meta.url), 'utf8');
  assert.match(css, /url\('\/assets\/forest-waves\.svg'\)/);
  assert.match(css, /@keyframes forest-waves/);
  assert.match(css, /prefers-reduced-motion:reduce[^}]*body\.glass-theme:before,body\.glass-theme:after\{animation:none;transform:none/);
  assert.doesNotMatch(svg, /<script|<foreignObject|<animate|href=/);
});

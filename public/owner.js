import { dashboardMetrics } from './dashboard.js';

const $ = id => document.getElementById(id);
let signedIn = false;
let analysisController;
let analyzing = false;

async function api(path, body, signal) {
  const response = await fetch(path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    credentials: 'same-origin',
    body: body === undefined ? undefined : JSON.stringify(body),
    signal,
  });
  const result = await response.json();
  if (!response.ok) {
    if (response.status === 401 && path !== '/api/login') setSignedIn(false);
    throw new Error(result.error || 'Request failed. Please try again.');
  }
  return result;
}

function setSignedIn(value) {
  signedIn = value;
  if (!value) {
    analysisController?.abort();
    $('analysis-form').reset();
    $('draft-form').reset();
    clearComparison();
    $('proposals').replaceChildren();
    window.location.replace('/login');
  } else {
    $('workspace').hidden = false;
    refreshProposals().catch(error => { $('status').textContent = error.message; });
  }
}

function clearComparison() {
  $('comparison').hidden = true;
  $('draft').hidden = true;
  $('classification').textContent = '';
  $('summary').textContent = '';
  $('items').replaceChildren();
}

function addText(parent, tag, text) {
  const node = document.createElement(tag);
  node.textContent = text;
  parent.append(node);
}

function renderComparison(result) {
  const labels = { additional: 'Potential additional work', included: 'Appears already included', unclear: 'Needs clarification' };
  $('classification').textContent = labels[result.classification];
  $('classification').className = result.classification === 'included' ? 'badge' : 'badge warning';
  $('summary').textContent = result.summary;
  $('items').replaceChildren();
  for (const [index, item] of result.items.entries()) {
    const card = document.createElement('article');
    card.className = 'item';
    addText(card, 'h3', `Item ${index + 1}: ${item.suggestedWork}`);
    addText(card, 'p', 'Client request excerpt');
    addText(card, 'blockquote', item.requestExcerpt);
    addText(card, 'p', 'Agreement evidence');
    addText(card, 'blockquote', item.agreementExcerpt || 'No supporting excerpt available. This alone does not prove the work is excluded.');
    addText(card, 'p', item.explanation);
    $('items').append(card);
  }
  $('comparison').hidden = false;
  $('draft').hidden = false;
  $('work').value = result.classification === 'additional' ? result.items.map(item => item.suggestedWork).join('\n\n') : '';
  $('title').value = result.classification === 'additional' ? 'Additional work proposal' : '';
  $('original-scope').value = [...new Set(result.items.map(item => item.agreementExcerpt).filter(Boolean))].join('\n\n').slice(0, 4000);
  $('change-reason').value = result.classification === 'additional' ? result.items.map(item => item.explanation).join('\n\n').slice(0, 4000) : '';
  $('reviewed').checked = false;
  $('review-warning').textContent = result.classification === 'additional'
    ? 'Review the suggested work, then set your own price and delivery change. Nothing is sent or charged.'
    : 'The AI has not established additional work. Clarify the request with your client before proposing any charge.';
}

$('logout').addEventListener('click', async () => {
  $('logout').disabled = true;
  try {
    await api('/api/logout', {});
    setSignedIn(false);
    $('status').textContent = 'Logged out. Unsaved inputs and drafts have been cleared.';
  } catch (error) {
    $('status').textContent = `Logout was not confirmed. ${error.message}`;
  } finally {
    $('logout').disabled = false;
  }
});

$('example').addEventListener('click', () => {
  $('agreement').value = 'Build a three-page website for $600, including Home, About, and Contact pages, a contact form, and one revision round.';
  $('request').value = 'Can you also add an online store with ten products?';
  clearComparison();
  $('draft-form').reset();
  $('status').textContent = 'Synthetic example loaded. Analyze it to get a real Groq comparison.';
});

for (const id of ['agreement', 'request']) {
  $(id).addEventListener('input', () => {
    analysisController?.abort();
    clearComparison();
    $('draft-form').reset();
    if (signedIn) $('status').textContent = 'Inputs changed. Analyze again for an updated comparison.';
  });
}

$('analysis-form').addEventListener('submit', async event => {
  event.preventDefault();
  if (analyzing) return;
  if ($('work').value && !window.confirm('Analyze again and replace the current unsaved draft?')) return;
  analyzing = true;
  analysisController = new AbortController();
  const controller = analysisController;
  $('analyze').disabled = true;
  $('example').disabled = true;
  $('analysis-form').setAttribute('aria-busy', 'true');
  clearComparison();
  $('draft-form').reset();
  $('status').textContent = 'Comparing the agreement and request with Groq…';
  try {
    const result = await api('/api/analyze', {
      agreement: $('agreement').value,
      newRequest: $('request').value,
    }, controller.signal);
    if (!signedIn || controller.signal.aborted) return;
    renderComparison(result);
    $('status').textContent = 'Comparison ready. Review the evidence and edit the draft below.';
    $('comparison').scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (error) {
    if (error.name !== 'AbortError') $('status').textContent = error.message;
  } finally {
    analyzing = false;
    $('analyze').disabled = false;
    $('example').disabled = false;
    $('analysis-form').removeAttribute('aria-busy');
  }
});

const usd = cents => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(cents / 100);

function renderDashboard(proposals) {
  const metrics = dashboardMetrics(proposals);
  $('total-count').textContent = String(metrics.total);
  $('paid-count').textContent = String(metrics.groups.paid);
  $('paid-total').textContent = usd(metrics.paidCents);
  $('open-total').textContent = usd(metrics.openCents);
  $('open-count').textContent = `${metrics.groups.awaiting} awaiting payment · ${metrics.groups.processing} processing or unconfirmed`;
  $('paid-rate').textContent = `${metrics.paidRate}%`;
  $('week-total').textContent = String(metrics.activity.reduce((sum, value) => sum + value.count, 0));
  $('month-total').textContent = usd(metrics.collections.at(-1));
  $('activity-chart').replaceChildren();
  const max = Math.max(1, ...metrics.activity.map(value => value.count));
  for (const value of metrics.activity) {
    const column = document.createElement('div');
    column.className = 'chart-column';
    const track = document.createElement('div');
    track.className = 'bar-track';
    const bar = document.createElement('div');
    bar.className = 'activity-bar';
    // SVG geometry avoids inline styles under the application's strict CSP.
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 100');
    svg.setAttribute('preserveAspectRatio', 'none');
    const rect = document.createElementNS(svg.namespaceURI, 'rect');
    const height = value.count / max * 100;
    for (const [name, number] of Object.entries({ x: 0, y: 100 - height, width: 24, height, rx: 5 })) rect.setAttribute(name, String(number));
    svg.append(rect);
    bar.append(svg);
    track.append(bar);
    addText(column, 'small', String(value.count));
    column.append(track);
    addText(column, 'span', new Date(`${value.date}T12:00:00Z`).toLocaleDateString('en-US', { weekday: 'short', timeZone: 'UTC' }));
    $('activity-chart').append(column);
  }
  $('activity-chart').setAttribute('aria-label', metrics.activity.map(value => `${value.date}: ${value.count} proposals`).join('; '));
  const ceiling = Math.max(1, ...metrics.collections);
  const points = metrics.collections.map((cents, index) => `${index * 400 / 29},${140 - cents / ceiling * 120}`);
  $('collection-line').setAttribute('d', `M${points.join(' L')}`);
  $('collection-area').setAttribute('d', `M0,150 L${points.join(' L')} L400,150 Z`);
  $('collection-chart').setAttribute('aria-label', `Cumulative confirmed sandbox payments over the last 30 UTC days: ${usd(metrics.collections.at(-1))}.`);
  $('pipeline').replaceChildren();
  for (const [group, label] of Object.entries({ paid: 'Paid', awaiting: 'Awaiting payment', processing: 'Processing / unconfirmed', failed: 'Failed / unavailable' })) {
    const row = document.createElement('div');
    row.className = `pipeline-row pipeline-${group}`;
    addText(row, 'span', label);
    addText(row, 'strong', String(metrics.groups[group]));
    const meter = document.createElement('meter');
    meter.min = 0;
    meter.max = Math.max(1, metrics.total);
    meter.value = metrics.groups[group];
    meter.setAttribute('aria-label', `${label}: ${metrics.groups[group]} of ${metrics.total}`);
    row.append(meter);
    $('pipeline').append(row);
  }
  $('overview').setAttribute('aria-busy', 'false');
}

async function refreshProposals() {
  const proposals = await api('/api/proposals');
  if (!signedIn) return;
  renderDashboard(proposals);
  $('proposals').replaceChildren();
  if (!proposals.length) {
    const empty = document.createElement('div');
    empty.className = 'dashboard-empty';
    addText(empty, 'h3', 'Your next agreement starts here.');
    addText(empty, 'p', 'Compare a client request, review the terms, and publish your first proposal.');
    const start = document.createElement('a');
    start.href = '#analysis-section';
    start.textContent = 'Create your first proposal →';
    empty.append(start);
    $('proposals').append(empty);
  }
  for (const proposal of proposals) {
    const card = document.createElement('article');
    card.className = 'item proposal-row';
    addText(card, 'h3', proposal.title);
    const meta = document.createElement('div');
    meta.className = 'proposal-meta';
    addText(meta, 'strong', `${usd(proposal.amountCents)} USD`);
    const state = document.createElement('span');
    state.className = `proposal-state ${proposal.status === 'paid' ? 'is-paid' : 'is-open'}`;
    state.textContent = proposal.status;
    meta.append(state);
    card.append(meta);
    if (proposal.captureId) addText(card, 'p', `PayPal transaction: ${proposal.captureId}`);
    const link = document.createElement('a');
    link.href = `/p/${proposal.token}`;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.textContent = new URL(link.href).href;
    card.append(link);
    const copy = document.createElement('button');
    copy.type = 'button';
    copy.textContent = 'Copy client link';
    copy.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(link.href);
        $('status').textContent = 'Client link copied. Anyone with this link can view the proposal.';
      } catch {
        $('status').textContent = 'Could not copy automatically. Copy the displayed link manually.';
      }
    });
    card.append(document.createElement('br'), copy);
    const check = document.createElement('button');
    check.type = 'button';
    check.textContent = 'Check payment status';
    check.addEventListener('click', async () => {
      check.disabled = true;
      try {
        const updated = await api(`/api/proposals/${proposal.token}/status`, {});
        $('status').textContent = `Payment status: ${updated.status}`;
        await refreshProposals();
      } catch (error) {
        $('status').textContent = error.message;
        check.disabled = false;
      }
    });
    card.append(document.createTextNode(' '), check);
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'danger';
    remove.textContent = 'Delete proposal';
    remove.setAttribute('aria-label', `Delete proposal: ${proposal.title}`);
    remove.addEventListener('click', async () => {
      if (!window.confirm(`Delete “${proposal.title}”? This removes it from your workspace and deactivates its client link. The database record and payment references are retained. This does not cancel or refund a PayPal payment.`)) return;
      remove.disabled = true;
      try {
        await api(`/api/proposals/${proposal.token}/delete`, {});
        $('status').textContent = 'Proposal deleted. Its client link is no longer available.';
        await refreshProposals();
      } catch (error) {
        $('status').textContent = error.message;
        remove.disabled = false;
      }
    });
    card.append(document.createTextNode(' '), remove);
    $('proposals').append(card);
  }
}

$('refresh-proposals').addEventListener('click', () => {
  $('refresh-proposals').disabled = true;
  refreshProposals().catch(error => { $('status').textContent = error.message; })
    .finally(() => { $('refresh-proposals').disabled = false; });
});

$('draft-form').addEventListener('submit', async event => {
  event.preventDefault();
  $('publish').disabled = true;
  try {
    const proposal = await api('/api/proposals', {
      title: $('title').value,
      work: $('work').value,
      originalScope: $('original-scope').value,
      changeReason: $('change-reason').value,
      originalAmount: $('original-amount').value,
      amount: $('amount').value,
      delivery: $('delivery').value,
      reviewed: $('reviewed').checked,
    });
    if (!signedIn) return;
    $('draft-form').reset();
    $('draft').hidden = true;
    $('status').textContent = `Published “${proposal.title}” with fixed terms. Copy its client link below.`;
    await refreshProposals();
    $('published').scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (error) {
    $('status').textContent = error.message;
  } finally {
    $('publish').disabled = false;
  }
});

api('/api/session').then(result => { $('account-name').textContent = result.user.name; $('workspace-greeting').textContent = `Welcome back, ${result.user.name}.`; setSignedIn(true); }).catch(error => {
  $('status').textContent = error.message;
});

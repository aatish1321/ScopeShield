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
  $('login-panel').hidden = value;
  $('workspace').hidden = !value;
  $('logout').hidden = !value;
  if (!value) {
    analysisController?.abort();
    $('analysis-form').reset();
    $('draft-form').reset();
    clearComparison();
    $('proposals').replaceChildren();
  } else {
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
  $('review-warning').textContent = result.classification === 'additional'
    ? 'Review the suggested work, then set your own price and delivery change. Nothing is sent or charged.'
    : 'The AI has not established additional work. Clarify the request with your client before proposing any charge.';
}

$('login-form').addEventListener('submit', async event => {
  event.preventDefault();
  const key = $('owner-key').value;
  $('owner-key').value = '';
  const button = event.submitter;
  button.disabled = true;
  try {
    await api('/api/login', { key });
    setSignedIn(true);
    $('status').textContent = 'Logged in. Paste an agreement and a new request to begin.';
    $('agreement').focus();
  } catch (error) {
    $('status').textContent = error.message;
    $('owner-key').focus();
  } finally {
    button.disabled = false;
  }
});

$('logout').addEventListener('click', async () => {
  $('logout').disabled = true;
  try {
    await api('/api/logout', {});
    setSignedIn(false);
    $('status').textContent = 'Logged out. Unsaved inputs and drafts have been cleared.';
    $('owner-key').focus();
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

async function refreshProposals() {
  const proposals = await api('/api/proposals');
  if (!signedIn) return;
  $('proposals').replaceChildren();
  if (!proposals.length) addText($('proposals'), 'p', 'No published proposals yet.');
  for (const proposal of proposals) {
    const card = document.createElement('article');
    card.className = 'item';
    addText(card, 'h3', proposal.title);
    addText(card, 'p', `${usd(proposal.amountCents)} USD · ${proposal.status}`);
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
    $('proposals').append(card);
  }
}

$('refresh-proposals').addEventListener('click', () => {
  refreshProposals().catch(error => { $('status').textContent = error.message; });
});

$('draft-form').addEventListener('submit', async event => {
  event.preventDefault();
  $('publish').disabled = true;
  try {
    const proposal = await api('/api/proposals', {
      title: $('title').value,
      work: $('work').value,
      amount: $('amount').value,
      delivery: $('delivery').value,
      reviewed: $('reviewed').checked,
    });
    if (!signedIn) return;
    $('draft-form').reset();
    $('draft').hidden = true;
    $('status').textContent = `Published “${proposal.title}” with fixed terms. Copy its client link below.`;
    await refreshProposals();
  } catch (error) {
    $('status').textContent = error.message;
  } finally {
    $('publish').disabled = false;
  }
});

api('/api/session').then(() => setSignedIn(true)).catch(error => {
  $('status').textContent = error.message;
});

const $ = id => document.getElementById(id);
const token = window.location.pathname.split('/')[2];
const labels = {
  unpaid: 'Unpaid — no checkout started.',
  creating: 'Checkout creation is unconfirmed. You may retry using the same saved request.',
  ready: 'Awaiting PayPal approval or capture. Payment is not yet confirmed.',
  capturing: 'Payment outcome is unconfirmed. Check payment status before retrying.',
  unknown: 'Payment outcome is unconfirmed. Check payment status before retrying.',
  pending: 'PayPal is processing the payment. Please check status later; do not pay again.',
  paid: 'Paid — payment confirmed by PayPal sandbox.',
  failed: 'Payment was declined or the order is no longer payable. Contact your freelancer before starting another payment.',
};

async function api(action, body) {
  if (!/^[a-f0-9]{64}$/.test(token || '')) throw new Error('Proposal unavailable. Check the link with your freelancer.');
  const response = await fetch(`/api/proposals/${token}${action}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    credentials: 'omit', body: body === undefined ? undefined : JSON.stringify(body),
  });
  const value = await response.json();
  if (!response.ok) throw new Error(value.error || 'Could not load this proposal.');
  return value;
}

function render(proposal) {
  $('title').textContent = proposal.title;
  $('work').textContent = proposal.work;
  $('delivery').textContent = proposal.delivery;
  $('amount').textContent = `${new Intl.NumberFormat('en-US', { style: 'currency', currency: proposal.currency }).format(proposal.amountCents / 100)} ${proposal.currency}`;
  $('payment-status').textContent = labels[proposal.status] || 'Payment status unconfirmed. Contact your freelancer.';
  $('receipt').hidden = !proposal.captureId;
  $('receipt').textContent = proposal.captureId ? `PayPal sandbox transaction: ${proposal.captureId}` : '';
  $('checkout-form').hidden = !proposal.checkoutAvailable || !['unpaid', 'ready', 'creating'].includes(proposal.status);
  $('check-status').hidden = !proposal.checkoutAvailable;
  $('checkout-notice').textContent = proposal.checkoutAvailable
    ? 'This demo uses PayPal sandbox only. No real funds move.'
    : 'PayPal sandbox checkout is not configured. Contact your freelancer.';
  $('proposal').hidden = false;
}

$('checkout-form').addEventListener('submit', async event => {
  event.preventDefault();
  $('pay').disabled = true;
  $('status').textContent = 'Preparing PayPal sandbox checkout…';
  try {
    const value = await api('/checkout', { accepted: $('accepted').checked });
    render(value.proposal);
    if (value.approvalUrl) {
      const url = new URL(value.approvalUrl);
      if (url.protocol !== 'https:' || !['www.sandbox.paypal.com', 'sandbox.paypal.com'].includes(url.hostname)) {
        throw new Error('Unexpected checkout destination. Contact your freelancer.');
      }
      window.location.assign(url.href);
    } else $('status').textContent = labels[value.proposal.status];
  } catch (error) {
    try { render(await api('')); } catch {
      $('payment-status').textContent = 'Payment outcome is unconfirmed. Check payment status before retrying.';
      $('checkout-form').hidden = true;
    }
    $('status').textContent = error.message;
  } finally { $('pay').disabled = false; }
});

$('check-status').addEventListener('click', async () => {
  $('check-status').disabled = true;
  try {
    const value = await api('/status', {});
    render(value);
    $('status').textContent = labels[value.status];
  } catch (error) { $('status').textContent = error.message; }
  finally { $('check-status').disabled = false; }
});

async function start() {
  const returned = new URLSearchParams(window.location.search).get('paypal');
  // Discard PayPal query parameters immediately; the server uses its stored order ID only.
  if (window.location.search) window.history.replaceState(null, '', window.location.pathname);
  render(await api(''));
  if (returned === 'return') {
    $('status').textContent = 'Confirming payment with PayPal…';
    render(await api('/capture', {}));
    $('status').textContent = $('payment-status').textContent;
  } else if (returned === 'cancel') {
    $('status').textContent = 'Checkout cancelled. A cancellation does not confirm payment; check status if you are unsure.';
  } else $('status').textContent = 'Review the approved work, price, and delivery change below.';
}

start().catch(error => {
  $('status').textContent = error.message;
  if (!$('proposal').hidden) {
    $('payment-status').textContent = 'Payment outcome is unconfirmed. Check payment status before retrying.';
    $('checkout-form').hidden = true;
  }
});

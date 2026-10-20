const $ = id => document.getElementById(id);
const token = window.location.pathname.split('/')[2];

async function loadProposal() {
  if (!/^[a-f0-9]{64}$/.test(token || '')) throw new Error('Proposal unavailable. Check the link with your freelancer.');
  const response = await fetch(`/api/proposals/${token}`, { credentials: 'omit' });
  const proposal = await response.json();
  if (!response.ok) throw new Error(proposal.error || 'Could not load this proposal.');
  $('title').textContent = proposal.title;
  $('work').textContent = proposal.work;
  $('delivery').textContent = proposal.delivery;
  $('amount').textContent = `${new Intl.NumberFormat('en-US', { style: 'currency', currency: proposal.currency }).format(proposal.amountCents / 100)} ${proposal.currency}`;
  $('payment-status').textContent = proposal.status;
  $('proposal').hidden = false;
  $('status').textContent = 'Review the approved work, price, and delivery change below.';
}

loadProposal().catch(error => {
  $('proposal').hidden = true;
  $('status').textContent = error.message;
});

const day = 86400000;
const dayStart = value => { const date = new Date(value); return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()); };

export function dashboardMetrics(proposals, now = new Date()) {
  const today = dayStart(now);
  const activity = Array.from({ length: 7 }, (_, index) => ({ date: new Date(today - (6 - index) * day).toISOString().slice(0, 10), count: 0 }));
  const collections = Array(30).fill(0);
  const groups = { paid: 0, awaiting: 0, processing: 0, failed: 0 };
  let paidCents = 0;
  let openCents = 0;
  for (const proposal of proposals) {
    const group = proposal.status === 'paid' ? 'paid' : proposal.status === 'failed' ? 'failed' : ['unpaid', 'ready'].includes(proposal.status) ? 'awaiting' : 'processing';
    groups[group]++;
    if (group === 'paid') paidCents += proposal.amountCents;
    if (group === 'awaiting') openCents += proposal.amountCents;
    const publishedIndex = 6 - (today - dayStart(proposal.createdAt)) / day;
    if (publishedIndex >= 0 && publishedIndex < 7) activity[publishedIndex].count++;
    if (proposal.status === 'paid' && proposal.paidAt) {
      const paidIndex = 29 - (today - dayStart(proposal.paidAt)) / day;
      if (paidIndex >= 0 && paidIndex < 30) collections[paidIndex] += proposal.amountCents;
    }
  }
  let cumulative = 0;
  return { total: proposals.length, groups, paidCents, openCents, activity,
    collections: collections.map(cents => cumulative += cents),
    paidRate: proposals.length ? Math.round(groups.paid / proposals.length * 100) : 0 };
}

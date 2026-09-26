export function invoiceStatus(invoice) {
  return String(invoice?.status ?? 'PENDING').toUpperCase();
}

export function isOpenVote(vote) {
  if (vote?.status) return String(vote.status).toUpperCase() === 'OPEN';
  if (vote?.result) return false;
  const now = Date.now();
  return (
    (!vote?.opensAt || new Date(vote.opensAt).getTime() <= now) &&
    !!vote?.closesAt &&
    new Date(vote.closesAt).getTime() >= now
  );
}

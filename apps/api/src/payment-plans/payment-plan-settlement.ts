export interface PlanReceivableInvoice {
  id: string;
  unitId: string;
  buildingId: string;
  periodYearMonth: string;
  totalCents: number;
  paidCents: number;
}

export interface PlanInvoiceAllocation {
  invoiceId: string;
  periodYearMonth: string;
  amountCents: number;
}

/**
 * Allocate a plan payment to the unit's outstanding invoices oldest first.
 * The caller is responsible for checking the total against the plan balance;
 * this helper refuses to silently discard an overpayment.
 */
export function allocatePlanPaymentToInvoices(
  invoices: PlanReceivableInvoice[],
  amountCents: number,
): PlanInvoiceAllocation[] {
  if (!Number.isSafeInteger(amountCents) || amountCents <= 0) {
    throw new Error('amountCents must be a positive integer');
  }
  const normalized = invoices
    .filter(
      (invoice) =>
        Number.isSafeInteger(invoice.totalCents) &&
        Number.isSafeInteger(invoice.paidCents) &&
        invoice.paidCents >= 0 &&
        invoice.totalCents > invoice.paidCents,
    )
    .sort(
      (a, b) =>
        a.periodYearMonth.localeCompare(b.periodYearMonth) ||
        a.id.localeCompare(b.id),
    );

  const outstanding = normalized.reduce(
    (sum, invoice) => sum + invoice.totalCents - invoice.paidCents,
    0,
  );
  if (amountCents > outstanding) {
    throw new Error(
      `amountCents exceeds the unit's outstanding invoice balance (${outstanding})`,
    );
  }

  let remaining = amountCents;
  const allocations: PlanInvoiceAllocation[] = [];
  for (const invoice of normalized) {
    if (remaining <= 0) break;
    const applied = Math.min(
      remaining,
      invoice.totalCents - invoice.paidCents,
    );
    if (applied > 0) {
      allocations.push({
        invoiceId: invoice.id,
        periodYearMonth: invoice.periodYearMonth,
        amountCents: applied,
      });
      remaining -= applied;
    }
  }
  if (remaining !== 0) {
    throw new Error('Unable to allocate the complete plan payment');
  }
  return allocations;
}

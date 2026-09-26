import {
  balanceCents,
  calculateInvoiceTotals,
  getBuildingId,
  homeForRole,
  invoiceDueCents,
  normalizeAnnouncements,
  normalizeInvoices,
} from './contracts';

describe('mobile screen contracts', () => {
  it('resolves the active building from the API membership contract', () => {
    expect(
      getBuildingId({
        buildingId: null,
        memberships: [
          { isDefault: false, building: { id: 'b-secondary' } },
          { isDefault: true, building: { id: 'b-active' } },
        ],
      }),
    ).toBe('b-active');
  });

  it('normalizes invoice and announcement envelope responses', () => {
    expect(normalizeInvoices({ items: [{ id: 'i1' }] })).toEqual([{ id: 'i1' }]);
    expect(normalizeAnnouncements({ announcements: [{ id: 'a1' }] })).toEqual([
      { id: 'a1' },
    ]);
  });

  it('calculates outstanding and paid totals from invoice arrays', () => {
    const invoices = [
      { id: 'paid', totalCents: 10_000, paidCents: 10_000, status: 'PAID' },
      { id: 'partial', totalCents: 12_000, paidCents: 2_000, status: 'PENDING' },
      { id: 'unpaid', totalCents: 5_000, paidCents: 0, status: 'PENDING' },
    ];

    expect(calculateInvoiceTotals(invoices)).toEqual({
      totalCents: 27_000,
      paidCents: 12_000,
      outstandingCents: 15_000,
      count: 3,
    });
    expect(balanceCents(invoices)).toBe(15_000);
    expect(balanceCents({ totalOutstanding: 2_500 })).toBe(2_500);
    expect(invoiceDueCents(invoices[1])).toBe(10_000);
  });

  it('routes resident, staff and unsupported roles explicitly', () => {
    expect(homeForRole('RESIDENT')).toBe('resident');
    expect(homeForRole('resident')).toBe('resident');
    expect(homeForRole('ADMIN')).toBe('staff');
    expect(homeForRole('BUILDING_OWNER')).toBe('staff');
    expect(homeForRole('PROVIDER')).toBe('unsupported');
    expect(homeForRole(undefined)).toBe('login');
  });
});

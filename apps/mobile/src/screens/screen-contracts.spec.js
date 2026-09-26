import { invoiceStatus, isOpenVote } from './screen-helpers';

describe('resident screen helpers', () => {
  it('normalizes invoice status for the balance badge', () => {
    expect(invoiceStatus({ status: 'paid' })).toBe('PAID');
    expect(invoiceStatus({})).toBe('PENDING');
  });

  it('uses the API status instead of treating scheduled votes as open', () => {
    expect(isOpenVote({ status: 'SCHEDULED', closesAt: '2099-01-01' })).toBe(false);
    expect(isOpenVote({ status: 'OPEN', closesAt: '2000-01-01' })).toBe(true);
    expect(isOpenVote({ result: 'PASSED', closesAt: '2099-01-01' })).toBe(false);
  });
});

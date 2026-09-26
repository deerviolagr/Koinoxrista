import {
  InvalidPeriodError,
  addPeriods,
  comparePeriods,
  formatPeriod,
  isPeriodInRange,
  isValidPeriod,
  nextPeriod,
  parsePeriod,
  periodRange,
  previousPeriod,
} from './period';

describe('period contracts', () => {
  it('validates and parses YYYY-MM values', () => {
    expect(isValidPeriod('2026-07')).toBe(true);
    expect(isValidPeriod('2026-00')).toBe(false);
    expect(isValidPeriod('26-07')).toBe(false);
    expect(parsePeriod('2026-07')).toEqual({ year: 2026, month: 7 });
    expect(() => parsePeriod('2026-13')).toThrow(InvalidPeriodError);
  });

  it('formats in UTC rather than the server timezone', () => {
    expect(formatPeriod(new Date('2026-01-31T23:59:59-05:00'))).toBe('2026-02');
  });

  it('navigates, compares, and bounds ranges', () => {
    expect(nextPeriod('2025-12')).toBe('2026-01');
    expect(previousPeriod('2026-01')).toBe('2025-12');
    expect(addPeriods('2026-07', -7)).toBe('2025-12');
    expect(comparePeriods('2026-07', '2026-08')).toBe(-1);
    expect(periodRange('2025-12', '2026-02')).toEqual([
      '2025-12',
      '2026-01',
      '2026-02',
    ]);
    expect(isPeriodInRange('2026-01', '2025-12', '2026-02')).toBe(true);
    expect(() => periodRange('2026-01', '2025-12')).toThrow(RangeError);
  });
});

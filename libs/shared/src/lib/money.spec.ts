import {
  CURRENCY_MINOR_UNITS,
  DEFAULT_CURRENCY,
  InvalidCurrencyError,
  formatEuros,
  formatMoney,
  getCurrencyMinorUnitDigits,
  parseMoney,
} from './money';

describe('currency-aware money primitives', () => {
  it('uses two minor digits for EUR and zero for CLP/COP/JPY', () => {
    expect(DEFAULT_CURRENCY).toBe('EUR');
    expect(getCurrencyMinorUnitDigits('EUR')).toBe(2);
    expect(getCurrencyMinorUnitDigits('CLP')).toBe(0);
    expect(getCurrencyMinorUnitDigits('COP')).toBe(0);
    expect(getCurrencyMinorUnitDigits('JPY')).toBe(0);
    expect(CURRENCY_MINOR_UNITS.CLP).toBe(0);
    expect(CURRENCY_MINOR_UNITS.COP).toBe(0);
    expect(CURRENCY_MINOR_UNITS.JPY).toBe(0);
  });

  it('keeps the legacy Greek euro rendering stable', () => {
    expect(formatEuros(12345)).toBe('123,45 €');
    expect(formatMoney(12345, { currency: 'EUR', locale: 'el-GR' })).toContain('123,45');
  });

  it('formats zero-decimal currencies without inventing fractional units', () => {
    expect(formatMoney(1235, { currency: 'CLP', locale: 'es-CL', currencyDisplay: 'code' })).toContain('1.235');
    expect(formatMoney(1235, { currency: 'COP', locale: 'es-CO', currencyDisplay: 'code' })).toContain('1.235');
    expect(formatMoney(1235, { currency: 'JPY', locale: 'ja-JP', currencyDisplay: 'code' })).toContain('1,235');
    expect(formatMoney(1235, { currency: 'JPY', locale: 'en-US', currencyDisplay: 'code' })).not.toContain('.00');
  });

  it('parses local decimal separators and round-trips minor units', () => {
    expect(parseMoney('1.234,56', 'EUR')).toBe(123456);
    expect(parseMoney('1,234.56', 'EUR')).toBe(123456);
    expect(parseMoney('1,235', 'CLP')).toBe(1235);
    expect(parseMoney('1,235', 'COP')).toBe(1235);
    expect(parseMoney('1235', 'JPY')).toBe(1235);
    expect(parseMoney('0', 'JPY')).toBe(0);
  });

  it('rejects invalid currencies and excess precision', () => {
    expect(() => parseMoney('1', 'XYZ')).toThrow(InvalidCurrencyError);
    expect(() => formatMoney(1, { currency: 'XYZ' })).toThrow(InvalidCurrencyError);
    expect(() => parseMoney('1.0', 'JPY')).toThrow(RangeError);
    expect(() => parseMoney('1.234,567', 'EUR')).toThrow(RangeError);
  });
});

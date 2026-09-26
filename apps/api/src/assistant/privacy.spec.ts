import { redactPii } from './privacy';

describe('assistant PII redaction', () => {
  it('redacts email, phone, IBAN, and card-like identifiers', () => {
    const value = redactPii(
      'Email maria@example.gr, τηλ 210 123 4567, IBAN GR1601101250000000012300695, card 4111 1111 1111 1111',
    );
    expect(value).toContain('[email]');
    expect(value).toContain('[phone]');
    expect(value).toContain('[iban]');
    expect(value).toContain('[card]');
    expect(value).not.toContain('maria@example.gr');
    expect(value).not.toContain('210 123 4567');
  });

  it('redacts labelled identity data and bounds context length', () => {
    expect(redactPii('Owner: Μαρία Παπαδοπούλου')).toContain('[name]');
    expect(redactPii('My name is Maria Papadopoulou')).toBe('[name]');
    expect(redactPii('Maria Papadopoulou')).toBe('[name]');
    expect(redactPii('x'.repeat(3000), 32)).toHaveLength(32);
  });
});

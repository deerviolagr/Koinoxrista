import {
  assertLoginTicketAttemptsOpen,
  consumeLoginTicketLocally,
  recordLoginTicketFailure,
  resetLoginTicketState,
  signLoginTicket,
  verifyLoginTicket,
} from './login-ticket';

const names = [
  'JWT_2FA_SECRET',
  'TWO_FACTOR_TICKET_SECRET',
  'JWT_TWO_FACTOR_SECRET',
  'TWO_FACTOR_JWT_SECRET',
  'JWT_2FA_TICKET_SECRET',
] as const;

describe('2FA login tickets', () => {
  const saved = new Map<string, string | undefined>();

  beforeEach(() => {
    for (const name of names) {
      saved.set(name, process.env[name]);
      delete process.env[name];
    }
    process.env.JWT_2FA_SECRET =
      'ticket-test-secret-012345678901234567890123456789';
    resetLoginTicketState();
  });

  afterAll(() => {
    for (const name of names) {
      const value = saved.get(name);
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  it('rejects the historical development default instead of signing with it', () => {
    process.env.JWT_2FA_SECRET = 'dev-only-two-factor-ticket-secret';

    expect(() => signLoginTicket('user-1')).toThrow(/JWT_2FA_SECRET/);
    expect(verifyLoginTicket('not-a-valid-ticket')).toBeNull();
  });

  it('signs and verifies with the dedicated key, with a unique nonce', () => {
    const first = signLoginTicket('user-1');
    const second = signLoginTicket('user-1');
    expect(verifyLoginTicket(first)).toBe('user-1');
    expect(verifyLoginTicket(second)).toBe('user-1');
    expect(first).not.toBe(second);
  });

  it('has a one-use process-local fallback for legacy generated clients', () => {
    const ticket = signLoginTicket('user-1');
    expect(consumeLoginTicketLocally(ticket)).toBe(true);
    expect(consumeLoginTicketLocally(ticket)).toBe(false);
  });

  it('locks a ticket after the bounded invalid-code attempt budget', () => {
    const ticket = signLoginTicket('user-1');
    for (let i = 0; i < 4; i++) {
      expect(recordLoginTicketFailure(ticket)).toBe(false);
    }
    expect(recordLoginTicketFailure(ticket)).toBe(true);
    expect(() => assertLoginTicketAttemptsOpen(ticket)).toThrow(
      /too many invalid two-factor attempts/i,
    );
  });
});

import { TwoFactorService } from './two-factor.service';
import {
  hashLoginTicket,
  signLoginTicket,
  verifyLoginTicket,
} from './login-ticket';
import type { PrismaService } from '../prisma/prisma.service';
import type { AuditService } from '../audit/audit.service';

describe('durable 2FA ticket storage', () => {
  const previousSecret = process.env.JWT_2FA_SECRET;
  beforeAll(() => {
    process.env.JWT_2FA_SECRET =
      'ticket-store-secret-012345678901234567890123456789';
  });
  afterAll(() => {
    if (previousSecret === undefined) delete process.env.JWT_2FA_SECRET;
    else process.env.JWT_2FA_SECRET = previousSecret;
  });

  it('stores only a namespaced hash and consumes it with a conditional update', async () => {
    const prisma = {
      emailVerification: {
        create: jest.fn().mockResolvedValue({ id: 'ticket-row' }),
        updateMany: jest
          .fn()
          .mockResolvedValueOnce({ count: 1 })
          .mockResolvedValueOnce({ count: 0 }),
      },
    };
    const service = new TwoFactorService(
      prisma as unknown as PrismaService,
      { record: jest.fn() } as unknown as AuditService,
    );

    const ticket = await service.issueLoginTicket('user-1');
    expect(ticket).toContain('.');
    expect(prisma.emailVerification.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        userId: 'user-1',
        tokenHash: hashLoginTicket(ticket),
      }),
    });
    expect(
      JSON.stringify(prisma.emailVerification.create.mock.calls),
    ).not.toContain(ticket);

    await expect(service.consumeLoginTicket(ticket, 'user-1')).resolves.toBe(
      true,
    );
    await expect(service.consumeLoginTicket(ticket, 'user-1')).resolves.toBe(
      false,
    );
    expect(prisma.emailVerification.updateMany).toHaveBeenCalledWith({
      where: expect.objectContaining({
        userId: 'user-1',
        tokenHash: hashLoginTicket(ticket),
        consumedAt: null,
      }),
      data: { consumedAt: expect.any(Date) },
    });
  });

  it('rejects a ticket signed with a different secret', () => {
    const previous = process.env.JWT_2FA_SECRET;
    process.env.JWT_2FA_SECRET =
      'a-ticket-secret-012345678901234567890123456789';
    const ticket = signLoginTicket('user-1');
    process.env.JWT_2FA_SECRET =
      'b-ticket-secret-012345678901234567890123456789';
    try {
      expect(verifyLoginTicket(ticket)).toBeNull();
    } finally {
      if (previous === undefined) delete process.env.JWT_2FA_SECRET;
      else process.env.JWT_2FA_SECRET = previous;
    }
  });
});

import { BadRequestException } from '@nestjs/common';
import { Role } from '@prisma/client';

import { AuthService } from '../auth/auth.service';
import { PrismaService } from '../prisma/prisma.service';
import { TwoFactorService } from '../two-factor/two-factor.service';
import { InvitesService } from './invites.service';
import type { CreateInviteDto } from './dto/create-invite.dto';

const invite = (overrides: Record<string, unknown> = {}) => ({
  id: 'invite-1',
  email: 'invited@example.gr',
  role: Role.ADMIN,
  buildingId: 'building-1',
  unitId: null,
  expiresAt: new Date(Date.now() + 60_000),
  acceptedAt: null,
  tokenHash: 'unused',
  invitedById: 'admin-1',
  createdAt: new Date(),
  ...overrides,
});

describe('invite escalation and binding', () => {
  it('rejects platform roles at the service boundary', async () => {
    const prisma = {
      unit: { findFirst: jest.fn() },
      invite: { findFirst: jest.fn(), create: jest.fn() },
      user: { findUnique: jest.fn() },
      ownership: { findFirst: jest.fn() },
      membership: { findFirst: jest.fn() },
    };
    const service = new InvitesService(prisma as unknown as PrismaService);
    await expect(
      service.create(
        'building-1',
        {
          email: 'x@example.gr',
          role: Role.PLATFORM_ADMIN,
        } as unknown as CreateInviteDto,
        {
          id: 'admin-1',
          email: 'admin@example.gr',
          role: Role.ADMIN,
          buildingId: 'building-1',
        },
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.invite.create).not.toHaveBeenCalled();
  });

  it('rejects a registration email that differs from the normalized invite email', async () => {
    const prisma = {
      invite: { findUnique: jest.fn().mockResolvedValue(invite()) },
      user: { create: jest.fn() },
      $transaction: jest.fn(),
    };
    const service = new AuthService(
      prisma as unknown as PrismaService,
      {} as never,
      {} as TwoFactorService,
    );
    await expect(
      service.register({
        email: 'other@example.gr',
        password: 'Passw0rd!',
        firstName: 'A',
        lastName: 'B',
        inviteToken: 'raw-token',
      }),
    ).rejects.toMatchObject({ status: 400 });
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('does not provision anything when the atomic invite claim loses the race', async () => {
    const tx = {
      invite: { updateMany: jest.fn().mockResolvedValue({ count: 0 }) },
      user: { create: jest.fn() },
      unit: { findFirst: jest.fn() },
      ownership: { create: jest.fn() },
      membership: { create: jest.fn() },
    };
    const prisma = {
      invite: { findUnique: jest.fn().mockResolvedValue(invite()) },
      user: { create: jest.fn() },
      $transaction: jest.fn(async (fn: (value: typeof tx) => unknown) =>
        fn(tx),
      ),
    };
    const service = new AuthService(
      prisma as unknown as PrismaService,
      {} as never,
      {} as TwoFactorService,
    );
    await expect(
      service.register({
        email: 'INVITED@example.gr',
        password: 'Passw0rd!',
        firstName: 'A',
        lastName: 'B',
        inviteToken: 'raw-token',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(tx.user.create).not.toHaveBeenCalled();
    expect(tx.membership.create).not.toHaveBeenCalled();
  });
});

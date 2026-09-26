import './test-env';
import { UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Role, User } from '@prisma/client';
import * as bcrypt from 'bcryptjs';

import { AuthService } from './auth.service';
import { JWT_ACCESS_SECRET, JWT_REFRESH_SECRET } from './auth.types';
import { signLoginTicket } from '../two-factor/login-ticket';
import type { TwoFactorService } from '../two-factor/two-factor.service';
import type { PrismaService } from '../prisma/prisma.service';
import type { SessionsService } from '../sessions/sessions.service';
import { JwtStrategy } from './jwt.strategy';

const statuses = [
  'ACTIVE',
  'PENDING_VERIFICATION',
  'PENDING_APPROVAL',
  'DISABLED',
  'REJECTED',
] as const;

const userFor = (status: (typeof statuses)[number]): User =>
  ({
    id: `user-${status}`,
    email: `${status.toLowerCase()}@example.gr`,
    passwordHash: bcrypt.hashSync('Passw0rd!', 4),
    firstName: 'Test',
    lastName: 'User',
    phone: null,
    role: Role.RESIDENT,
    buildingId: 'building-1',
    twoFactorSecret: null,
    twoFactorEnabled: false,
    status,
    locale: 'en',
    pointBalance: 0,
    createdAt: new Date(),
  }) as User;

describe('ACTIVE identity status matrix', () => {
  const jwt = new JwtService();

  it('allows password login only for ACTIVE users', async () => {
    for (const status of statuses) {
      const user = userFor(status);
      const prisma = {
        user: { findUnique: jest.fn().mockResolvedValue(user) },
      };
      const sessions = {
        record: jest.fn().mockResolvedValue(undefined),
      };
      const service = new AuthService(
        prisma as unknown as PrismaService,
        jwt,
        {} as TwoFactorService,
        sessions as unknown as SessionsService,
      );

      if (status === 'ACTIVE') {
        await expect(
          service.login({ email: user.email, password: 'Passw0rd!' }),
        ).resolves.toHaveProperty('accessToken');
        expect(sessions.record).toHaveBeenCalled();
      } else {
        await expect(
          service.login({ email: user.email, password: 'Passw0rd!' }),
        ).rejects.toBeInstanceOf(UnauthorizedException);
        expect(sessions.record).not.toHaveBeenCalled();
      }
    }
  });

  it('rejects refresh for every non-ACTIVE status', async () => {
    for (const status of statuses.slice(1)) {
      const user = userFor(status);
      const refresh = jwt.sign(
        { sub: user.id, type: 'refresh' },
        { secret: JWT_REFRESH_SECRET, expiresIn: '7d' },
      );
      const prisma = {
        user: { findUnique: jest.fn().mockResolvedValue(user) },
      };
      const sessions = {
        assertNotRevoked: jest.fn().mockResolvedValue(undefined),
        rotate: jest.fn().mockResolvedValue(undefined),
      };
      const service = new AuthService(
        prisma as unknown as PrismaService,
        jwt,
        {} as TwoFactorService,
        sessions as unknown as SessionsService,
      );
      await expect(service.refresh(refresh)).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
      expect(sessions.assertNotRevoked).not.toHaveBeenCalled();
    }
  });

  it('rejects 2FA completion and JWT strategy validation for disabled users', async () => {
    const user = userFor('DISABLED');
    const ticket = signLoginTicket(user.id);
    const verifyCode = jest.fn().mockResolvedValue(true);
    const prisma = {
      user: { findUnique: jest.fn().mockResolvedValue(user) },
    };
    const service = new AuthService(prisma as unknown as PrismaService, jwt, {
      verifyLoginCode: verifyCode,
    } as unknown as TwoFactorService);
    await expect(
      service.verifyTwoFactorLogin({ ticket, token: '123456' }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(verifyCode).not.toHaveBeenCalled();

    const access = jwt.sign(
      {
        sub: user.id,
        type: 'access',
        email: user.email,
        role: user.role,
        buildingId: user.buildingId,
      },
      { secret: JWT_ACCESS_SECRET, expiresIn: '15m' },
    );
    const strategy = new JwtStrategy(jwt, prisma as unknown as PrismaService);
    await expect(
      strategy.authenticate(`Bearer ${access}`),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });
});

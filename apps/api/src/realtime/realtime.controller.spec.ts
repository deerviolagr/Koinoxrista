import { JwtService } from '@nestjs/jwt';

import { JWT_REFRESH_SECRET, REFRESH_COOKIE_NAME } from '../auth/auth.types';
import { RealtimeController } from './realtime.controller';
import { RealtimeService } from './realtime.service';
import type { PrismaService } from '../prisma/prisma.service';
import type { SessionsService } from '../sessions/sessions.service';

const makeUser = (status: string) => ({
  id: 'user-1',
  buildingId: 'building-1',
  status,
});

describe('realtime cookie authentication', () => {
  it('requires a live session and ACTIVE user', async () => {
    const jwt = new JwtService();
    const token = jwt.sign(
      { sub: 'user-1', type: 'refresh' },
      { secret: JWT_REFRESH_SECRET, expiresIn: '7d' },
    );
    const prisma = {
      user: { findUnique: jest.fn().mockResolvedValue(makeUser('ACTIVE')) },
    };
    const sessions = {
      assertNotRevoked: jest.fn().mockResolvedValue(undefined),
    };
    const controller = new RealtimeController(
      new RealtimeService(),
      jwt,
      prisma as unknown as PrismaService,
      sessions as unknown as SessionsService,
    );
    const req = {
      headers: { cookie: `${REFRESH_COOKIE_NAME}=${token}` },
    } as never;

    await expect(
      (
        controller as unknown as {
          resolveUserFromCookie(value: unknown): Promise<unknown>;
        }
      ).resolveUserFromCookie(req),
    ).resolves.toEqual({ id: 'user-1', buildingId: 'building-1' });
    expect(sessions.assertNotRevoked).toHaveBeenCalledWith(token, 'user-1');

    prisma.user.findUnique.mockResolvedValue(makeUser('DISABLED'));
    await expect(
      (
        controller as unknown as {
          resolveUserFromCookie(value: unknown): Promise<unknown>;
        }
      ).resolveUserFromCookie(req),
    ).resolves.toBeNull();
  });

  it('rejects a revoked refresh session before loading the user', async () => {
    const jwt = new JwtService();
    const token = jwt.sign(
      { sub: 'user-1', type: 'refresh' },
      { secret: JWT_REFRESH_SECRET, expiresIn: '7d' },
    );
    const prisma = { user: { findUnique: jest.fn() } };
    const sessions = {
      assertNotRevoked: jest.fn().mockRejectedValue(new Error('revoked')),
    };
    const controller = new RealtimeController(
      new RealtimeService(),
      jwt,
      prisma as unknown as PrismaService,
      sessions as unknown as SessionsService,
    );
    const req = {
      headers: { cookie: `${REFRESH_COOKIE_NAME}=${token}` },
    } as never;

    await expect(
      (
        controller as unknown as {
          resolveUserFromCookie(value: unknown): Promise<unknown>;
        }
      ).resolveUserFromCookie(req),
    ).resolves.toBeNull();
    expect(prisma.user.findUnique).not.toHaveBeenCalled();
  });
});

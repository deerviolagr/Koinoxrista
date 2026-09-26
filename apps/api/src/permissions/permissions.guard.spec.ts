import { ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import { PrismaService } from '../prisma/prisma.service';
import { RequirePermission } from './permissions.decorator';
import { PermissionsGuard } from './permissions.guard';
import { PermissionsService } from './permissions.service';

const context = (request: Record<string, unknown>) =>
  ({
    switchToHttp: () => ({ getRequest: () => request }),
    getHandler: () => () => undefined,
    getClass: () => class {},
  }) as any;

describe('PermissionsGuard', () => {
  let reflector: { getAllAndOverride: jest.Mock };
  let permissions: { require: jest.Mock };
  let prisma: { vote: { findUnique: jest.Mock } };
  let guard: PermissionsGuard;

  beforeEach(() => {
    reflector = { getAllAndOverride: jest.fn() };
    permissions = { require: jest.fn().mockResolvedValue(undefined) };
    prisma = { vote: { findUnique: jest.fn() } };
    guard = new PermissionsGuard(
      reflector as unknown as Reflector,
      permissions as unknown as PermissionsService,
      prisma as unknown as PrismaService,
    );
  });

  it('is a no-op when no permission metadata is present', async () => {
    reflector.getAllAndOverride.mockReturnValue(undefined);
    await expect(guard.canActivate(context({ user: { id: 'u' } }))).resolves.toBe(true);
    expect(permissions.require).not.toHaveBeenCalled();
  });

  it('enforces all required permissions for a direct building route', async () => {
    reflector.getAllAndOverride.mockReturnValue(['votes.manage']);
    await guard.canActivate(
      context({
        user: { id: 'u' },
        params: { buildingId: 'b1' },
      }),
    );
    expect(permissions.require).toHaveBeenCalledWith(
      expect.anything(),
      'b1',
      'votes.manage',
    );
  });

  it('resolves a vote resource before checking a resource-id route', async () => {
    reflector.getAllAndOverride.mockReturnValue(['votes.manage']);
    prisma.vote.findUnique.mockResolvedValue({ buildingId: 'b7' });
    await guard.canActivate(
      context({
        user: { id: 'u' },
        params: { voteId: 'v1' },
      }),
    );
    expect(prisma.vote.findUnique).toHaveBeenCalledWith({
      where: { id: 'v1' },
      select: { buildingId: true },
    });
    expect(permissions.require).toHaveBeenCalledWith(
      expect.anything(),
      'b7',
      'votes.manage',
    );
  });

  it('rejects invalid metadata instead of silently dropping a key', async () => {
    reflector.getAllAndOverride.mockReturnValue(['not-a-permission']);
    await expect(
      guard.canActivate(context({ user: { id: 'u' }, params: { buildingId: 'b1' } })),
    ).rejects.toThrow(ForbiddenException);
  });

  it('exposes the reusable decorator metadata', () => {
    class Dummy {
      @RequirePermission('votes.manage')
      handler(): void {
        return undefined;
      }
    }
    expect(Reflect.getMetadata('permissions', Dummy.prototype.handler)).toEqual([
      'votes.manage',
    ]);
  });
});

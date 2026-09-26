import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Role } from '@prisma/client';

import { RolesGuard } from './guards/roles.guard';

const context = (user: Record<string, unknown>, params: Record<string, string>) =>
  ({
    switchToHttp: () => ({ getRequest: () => ({ user, params }) }),
    getHandler: () => () => undefined,
    getClass: () => class {},
  }) as unknown as ExecutionContext;

describe('RolesGuard Membership resolution', () => {
  it('uses the requested building Membership instead of the active User role', async () => {
    const reflector = {
      getAllAndOverride: jest.fn().mockReturnValue([Role.ADMIN]),
    };
    const memberships = {
      requireMembership: jest.fn().mockResolvedValue({ role: Role.ADMIN }),
    };
    const guard = new RolesGuard(
      reflector as unknown as Reflector,
      memberships as any,
    );

    await expect(
      guard.canActivate(
        context(
          { id: 'u1', role: Role.RESIDENT, buildingId: 'building-1' },
          { buildingId: 'building-2' },
        ),
      ),
    ).resolves.toBe(true);
    expect(memberships.requireMembership).toHaveBeenCalledWith('u1', 'building-2');
  });

  it('does not fall back to the active building for a foreign Membership miss', async () => {
    const reflector = {
      getAllAndOverride: jest.fn().mockReturnValue([Role.ADMIN]),
    };
    const memberships = {
      requireMembership: jest.fn().mockRejectedValue(new ForbiddenException()),
    };
    const guard = new RolesGuard(
      reflector as unknown as Reflector,
      memberships as any,
    );

    await expect(
      guard.canActivate(
        context(
          { id: 'u1', role: Role.ADMIN, buildingId: 'building-1' },
          { buildingId: 'building-2' },
        ),
      ),
    ).rejects.toThrow(ForbiddenException);
  });
});

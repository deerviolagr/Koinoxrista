import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  Inject,
  Optional,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Role } from '@prisma/client';

import {
  ADMIN_LIKE_ROLES,
  roleSatisfies,
} from '../../common/tenant';
import { MembershipsService } from '../../memberships/memberships.service';
import { HttpRequest } from '../auth.types';
import { ROLES_KEY } from '../decorators/roles.decorator';

const ADMIN_LIKE: Role[] = [...ADMIN_LIKE_ROLES];

/**
 * Resolves the effective building role for a route. A Membership is
 * authoritative when the request names a building, so switching the active
 * building cannot accidentally authorize a role from a different tenant. The
 * User row remains a compatibility fallback for legacy rows.
 */
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    @Optional()
    @Inject(MembershipsService)
    private readonly memberships?: MembershipsService,
  ) {}

  canActivate(context: ExecutionContext): boolean | Promise<boolean> {
    const requiredRoles = this.reflector.getAllAndOverride<Role[] | undefined>(
      ROLES_KEY,
      [context.getHandler(), context.getClass()],
    );

    if (!requiredRoles || requiredRoles.length === 0) {
      return true;
    }

    const request = context.switchToHttp().getRequest<
      HttpRequest & {
        params?: Record<string, string | undefined>;
      }
    >();
    const user = request.user;
    if (!user) throw new ForbiddenException('Insufficient role');

    const buildingId = request.params?.buildingId;
    // Keep the no-tenant path synchronous. Apart from preserving the guard's
    // inexpensive behaviour, this makes it usable by token-only endpoints
    // where no database lookup is possible.
    if (!buildingId || !this.memberships) {
      if (!roleSatisfies(requiredRoles, user.role)) {
        throw new ForbiddenException('Insufficient role');
      }
      return true;
    }

    return this.resolveMembershipRole(user.id, buildingId).then(
      (role) => {
        if (!roleSatisfies(requiredRoles, role)) {
          throw new ForbiddenException('Insufficient role');
        }
        return true;
      },
      (error: unknown) => {
        // A legacy user may predate Membership creation. Only the active
        // building gets the legacy fallback; a foreign building never does.
        if (user.buildingId !== buildingId) {
          if (error instanceof ForbiddenException) {
            throw new ForbiddenException('Insufficient role');
          }
          throw error;
        }
        if (!roleSatisfies(requiredRoles, user.role)) {
          throw new ForbiddenException('Insufficient role');
        }
        return true;
      },
    );
  }

  private async resolveMembershipRole(
    userId: string,
    buildingId: string,
  ): Promise<Role> {
    const reader = this.memberships as {
      requireMembership?: (
        id: string,
        building: string,
      ) => Promise<{ role: Role } | Role>;
      membership?: {
        findUnique?: (args: unknown) => Promise<{ role: Role } | null>;
      };
    };
    if (reader.requireMembership) {
      const membership = await reader.requireMembership(userId, buildingId);
      return typeof membership === 'string' ? membership : membership.role;
    }
    if (reader.membership?.findUnique) {
      const membership = await reader.membership.findUnique({
        where: { userId_buildingId: { userId, buildingId } },
        select: { role: true },
      });
      if (!membership) throw new ForbiddenException('Not a member of this building');
      return membership.role;
    }
    throw new ForbiddenException('Membership reader is unavailable');
  }
}

export { ADMIN_LIKE };

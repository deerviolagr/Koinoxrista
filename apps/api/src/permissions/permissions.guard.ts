import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import type { AuthenticatedUser } from '../auth/auth.types';
import { PrismaService } from '../prisma/prisma.service';
import { PERMISSION_KEY } from './permissions.decorator';
import {
  isPermissionKey,
  PermissionsService,
  type PermissionKey,
} from './permissions.service';

interface RequestWithContext {
  user?: AuthenticatedUser;
  params?: Record<string, string | undefined>;
  query?: Record<string, unknown>;
  body?: Record<string, unknown>;
}

/** Enforces the granular allow-list after JWT and role authorization. */
@Injectable()
export class PermissionsGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly permissions: PermissionsService,
    @Optional() private readonly prisma?: PrismaService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const required = this.reflector.getAllAndOverride<
      PermissionKey[] | PermissionKey | undefined
    >(PERMISSION_KEY, [context.getHandler(), context.getClass()]);
    if (!required) return true;

    const requestedKeys = Array.isArray(required) ? required : [required];
    if (
      requestedKeys.length === 0 ||
      requestedKeys.some((key) => !isPermissionKey(key))
    ) {
      throw new ForbiddenException('Invalid permission metadata');
    }
    const keys = requestedKeys as PermissionKey[];

    const request = context.switchToHttp().getRequest<RequestWithContext>();
    const user = request.user;
    if (!user) throw new ForbiddenException('Authentication required');

    const buildingId = await this.resolveBuildingId(request);
    if (!buildingId) {
      throw new ForbiddenException('A building context is required');
    }

    for (const key of keys) {
      await this.permissions.require(user, buildingId, key);
    }
    return true;
  }

  /** Resolve direct route params and the common resource-id route shapes. */
  private async resolveBuildingId(
    request: RequestWithContext,
  ): Promise<string | undefined> {
    const direct =
      request.params?.buildingId ??
      (typeof request.body?.buildingId === 'string'
        ? request.body.buildingId
        : undefined) ??
      (typeof request.query?.buildingId === 'string'
        ? request.query.buildingId
        : undefined);
    if (direct) return direct;
    if (!this.prisma) return undefined;

    const db = this.prisma as unknown as {
      vote?: { findUnique: (args: unknown) => Promise<{ buildingId: string } | null> };
      agendaItem?: { findUnique: (args: unknown) => Promise<{ buildingId: string } | null> };
      announcement?: { findUnique: (args: unknown) => Promise<{ buildingId: string } | null> };
      job?: { findUnique: (args: unknown) => Promise<{ buildingId: string } | null> };
    };
    const voteId = request.params?.voteId;
    if (voteId && db.vote?.findUnique) {
      const vote = await db.vote.findUnique({
        where: { id: voteId },
        select: { buildingId: true },
      });
      if (!vote) throw new NotFoundException('Vote not found');
      return vote.buildingId;
    }

    const resourceId = request.params?.id;
    if (resourceId && db.agendaItem?.findUnique) {
      const item = await db.agendaItem.findUnique({
        where: { id: resourceId },
        select: { buildingId: true },
      });
      if (!item) throw new NotFoundException('Agenda item not found');
      return item.buildingId;
    }

    const announcementId = request.params?.announcementId;
    if (announcementId && db.announcement?.findUnique) {
      const item = await db.announcement.findUnique({
        where: { id: announcementId },
        select: { buildingId: true },
      });
      if (!item) throw new NotFoundException('Announcement not found');
      return item.buildingId;
    }

    const jobId = request.params?.jobId;
    if (jobId && db.job?.findUnique) {
      const job = await db.job.findUnique({
        where: { id: jobId },
        select: { buildingId: true },
      });
      if (!job) throw new NotFoundException('Job not found');
      return job.buildingId;
    }
    return undefined;
  }
}

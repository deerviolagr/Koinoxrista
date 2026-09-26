import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { Prisma } from '@prisma/client';

import { AuthenticatedUser } from '../auth/auth.types';
import { assertSameBuilding } from '../common/tenant';
import { PrismaService } from '../prisma/prisma.service';
import { CreateOwnershipDto } from './dto/create-ownership.dto';
import {
  effectiveOwnershipWhere,
  effectiveUnitOwnershipWhere,
  isEffectiveOwnership,
  ownershipPeriodEndSupported,
} from './ownership-scope';

@Injectable()
export class OwnershipsService {
  constructor(private readonly prisma: PrismaService) {}

  async create(
    unitId: string,
    dto: CreateOwnershipDto,
    user: AuthenticatedUser,
  ) {
    if (!Number.isSafeInteger(dto.shareMillimes) || dto.shareMillimes <= 0) {
      throw new BadRequestException('shareMillimes must be a positive integer');
    }

    const periodStart = this.parseDate(dto.periodStart, 'periodStart');
    const periodEnd = this.parseDate(dto.periodEnd, 'periodEnd');
    if (periodStart && periodEnd && periodEnd < periodStart) {
      throw new BadRequestException('periodEnd must not be before periodStart');
    }
    if (periodEnd && !ownershipPeriodEndSupported()) {
      // Do not silently drop a requested historical end.  The deployment can
      // retry after the additive Ownership.periodEnd migration is generated.
      throw new BadRequestException(
        'periodEnd is not available until Ownership.periodEnd is installed',
      );
    }

    const unit = await this.prisma.unit.findUnique({
      where: { id: unitId },
    });
    if (!unit) {
      throw new NotFoundException('Unit not found');
    }
    assertSameBuilding(user, unit.buildingId);
    if (dto.shareMillimes > unit.millimes) {
      throw new BadRequestException(
        `Ownership share exceeds the unit's ${unit.millimes} millimes`,
      );
    }

    const targetUser = await this.prisma.user.findUnique({
      where: { id: dto.userId },
    });
    if (!targetUser) {
      throw new NotFoundException('User not found');
    }
    if (targetUser.buildingId && targetUser.buildingId !== unit.buildingId) {
      throw new ForbiddenException('User belongs to another building');
    }

    // A terminated owner must not consume the current share budget.  When a
    // start date is supplied, evaluate the budget at that date so historical
    // corrections cannot be overwritten by today's owner.
    const effectiveAt = periodStart ?? new Date();
    const aggregate = await this.prisma.ownership.aggregate({
      where: effectiveUnitOwnershipWhere(unitId, effectiveAt),
      _sum: { shareMillimes: true },
    });
    const allocated = aggregate._sum.shareMillimes ?? 0;
    if (allocated + dto.shareMillimes > unit.millimes) {
      throw new BadRequestException(
        `Ownership shares would total ${allocated + dto.shareMillimes} millimes but the unit only has ${unit.millimes}`,
      );
    }

    // Check overlap in application code as well as the aggregate.  This is
    // intentionally done before the transaction write; a person cannot own
    // two overlapping effective shares of the same unit.
    const existing = await this.prisma.ownership.findMany({
      where: { unitId },
    });
    const overlaps = existing.some((ownership) => {
      if (ownership.userId !== targetUser.id) return false;
      const dated = ownership as typeof ownership & {
        periodEnd?: Date | null;
      };
      const start = dated.periodStart ?? new Date(Number.NEGATIVE_INFINITY);
      const end = dated.periodEnd ?? new Date(Number.POSITIVE_INFINITY);
      const requestedStart = periodStart ?? new Date();
      const requestedEnd = periodEnd ?? new Date(Number.POSITIVE_INFINITY);
      return start <= requestedEnd && requestedStart <= end;
    });
    if (overlaps) {
      throw new ConflictException('Ownership periods overlap for this unit');
    }

    return this.prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      if (!targetUser.buildingId) {
        await tx.user.update({
          where: { id: targetUser.id },
          data: { buildingId: unit.buildingId },
        });
      }
      const data: Record<string, unknown> = {
        unitId,
        userId: targetUser.id,
        shareMillimes: dto.shareMillimes,
        periodStart,
      };
      // Keep the current schema build-compatible while writing the field as
      // soon as the optional migration is present in the generated client.
      if (periodEnd) data.periodEnd = periodEnd;
      return tx.ownership.create({
        data: data as Prisma.OwnershipUncheckedCreateInput,
      });
    });
  }

  async listForUnit(unitId: string, user: AuthenticatedUser) {
    const unit = await this.prisma.unit.findUnique({ where: { id: unitId } });
    if (!unit) {
      throw new NotFoundException('Unit not found');
    }
    assertSameBuilding(user, unit.buildingId);

    const include = {
      user: { select: { firstName: true, lastName: true, email: true } },
    } as const;

    // A resident may see their own effective link, not the full co-owner
    // directory of a unit.  Admins/building owners retain the management
    // view, including historical rows needed for audit and transfer.
    if (user.role !== 'ADMIN' && user.role !== 'BUILDING_OWNER') {
      const at = new Date();
      const rows = await this.prisma.ownership.findMany({
        where: effectiveOwnershipWhere(user.id, unit.buildingId, at, unitId),
        include,
      });
      const ownRows = rows.filter((ownership) =>
        isEffectiveOwnership(ownership, at),
      );
      if (ownRows.length === 0) {
        throw new ForbiddenException('You do not have an active ownership of this unit');
      }
      return ownRows;
    }

    return this.prisma.ownership.findMany({
      where: { unitId },
      include,
    });
  }

  private parseDate(value: string | null | undefined, field: string): Date | null {
    if (value == null) return null;
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) {
      throw new BadRequestException(`${field} must be a valid ISO date`);
    }
    return date;
  }
}

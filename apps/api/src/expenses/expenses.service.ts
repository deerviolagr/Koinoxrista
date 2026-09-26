import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';

import { AuthenticatedUser } from '../auth/auth.types';
import { isValidPeriod, TOTAL_MILLIMES } from '@org/shared';
import { assertSameBuilding } from '../common/tenant';
import { AuditService } from '../audit/audit.service';
import { PrismaService } from '../prisma/prisma.service';
import { splitByLargestRemainder, SplitResult } from '../prisma/split-by-largest-remainder';
import {
  assertSupportedAllocationStrategy,
  resolveAllocationWeights,
} from './allocation-weights';
import {
  isMetersStrategy,
  splitByMeterReading,
  validateAllUnitsHaveReadings,
} from '../meters/meter-allocation';
import { MetersService } from '../meters/meters.service';
import { CreateExpenseDto } from './dto/create-expense.dto';

@Injectable()
export class ExpensesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly meters: MetersService,
  ) {}

  async create(
    buildingId: string,
    dto: CreateExpenseDto,
    user: AuthenticatedUser,
  ) {
    assertSameBuilding(user, buildingId);
    if (typeof dto.description !== 'string' || dto.description.trim().length === 0) {
      throw new BadRequestException('description must not be blank');
    }
    if (!Number.isSafeInteger(dto.totalCents) || dto.totalCents <= 0) {
      throw new BadRequestException('totalCents must be a positive integer amount');
    }
    if (!isValidPeriod(dto.periodYearMonth)) {
      throw new BadRequestException('periodYearMonth must match YYYY-MM');
    }

    const category = await this.prisma.expenseCategory.findFirst({
      where: { id: dto.categoryId, buildingId },
    });
    if (!category) {
      throw new NotFoundException('Category not found');
    }

    const units = await this.prisma.unit.findMany({
      where: { buildingId },
      orderBy: { label: 'asc' },
    });
    if (units.length === 0) {
      throw new BadRequestException('Building has no units to allocate to');
    }
    if (
      units.some(
        (unit) => !Number.isInteger(unit.millimes) || unit.millimes <= 0,
      )
    ) {
      throw new BadRequestException('Every unit must have positive integer millimes');
    }
    if (new Set(units.map((unit) => unit.id)).size !== units.length) {
      throw new BadRequestException('Building units must have unique ids');
    }
    const millimesTotal = units.reduce((sum, unit) => sum + unit.millimes, 0);
    if (millimesTotal !== TOTAL_MILLIMES) {
      throw new BadRequestException(
        `units must total ${TOTAL_MILLIMES} millimes before an expense can be allocated (got ${millimesTotal})`,
      );
    }
    assertSupportedAllocationStrategy(category.strategy);

    let splits: SplitResult[];
    if (isMetersStrategy(category.strategy)) {
      splits = await this.splitByUnitConsumption(
        buildingId,
        units,
        dto.totalCents,
        dto.periodYearMonth,
      );
    } else {
      try {
        splits = splitByLargestRemainder(
          dto.totalCents,
          resolveAllocationWeights(units, category.strategy),
        );
      } catch (error) {
        if (error instanceof BadRequestException) throw error;
        throw new BadRequestException(
          error instanceof Error ? error.message : 'Invalid allocation weights',
        );
      }
    }
    if (
      splits.length !== units.length ||
      splits.reduce((sum, split) => sum + split.amountCents, 0) !== dto.totalCents
    ) {
      throw new BadRequestException(
        'Allocation must include every unit and must sum exactly to totalCents',
      );
    }

    const expense = await this.prisma.$transaction(async (tx) => {
      const created = await tx.expense.create({
        data: {
          buildingId,
          categoryId: category.id,
          description: dto.description,
          totalCents: dto.totalCents,
          periodYearMonth: dto.periodYearMonth,
          createdById: user.id,
        },
      });
      await tx.share.createMany({
        data: splits.map((split) => ({
          expenseId: created.id,
          unitId: split.id,
          amountCents: split.amountCents,
        })),
      });
      return tx.expense.findUniqueOrThrow({
        where: { id: created.id },
        include: { shares: true, category: true },
      });
    });
    this.audit.record({
      buildingId,
      actorId: user.id,
      actorRole: user.role,
      action: 'expense.created',
      entity: 'expense',
      entityId: expense.id,
      metadata: {
        totalCents: dto.totalCents,
        periodYearMonth: dto.periodYearMonth,
      },
    });
    return expense;
  }

  /**
   * METERS strategy branch: splits by each unit's share of the building's
   * metered consumption for the expense period. Every unit must have at
   * least one reading — missing ones are a 400 listing the units.
   */
  private async splitByUnitConsumption(
    buildingId: string,
    units: Array<{ id: string }>,
    totalCents: number,
    periodYearMonth: string,
  ): Promise<SplitResult[]> {
    const consumptions = await this.meters.buildUnitConsumptions(
      buildingId,
      periodYearMonth,
    );
    const unitIdSet = new Set(units.map((unit) => unit.id));
    const buildingConsumptions = consumptions.filter((consumption) =>
      unitIdSet.has(consumption.unitId),
    );
    validateAllUnitsHaveReadings(
      units.map((unit) => unit.id),
      buildingConsumptions.filter((consumption) => consumption.hasReadings),
    );
    return splitByMeterReading(totalCents, buildingConsumptions).map((share) => ({
      id: share.unitId,
      amountCents: share.amountCents,
    }));
  }

  async list(
    buildingId: string,
    periodYearMonth: string | undefined,
    user: AuthenticatedUser,
  ) {
    assertSameBuilding(user, buildingId);

    return this.prisma.expense.findMany({
      where: {
        buildingId,
        ...(periodYearMonth ? { periodYearMonth } : {}),
      },
      include: { shares: true, category: true },
      orderBy: [{ periodYearMonth: 'desc' }, { createdAt: 'desc' }],
    });
  }
}

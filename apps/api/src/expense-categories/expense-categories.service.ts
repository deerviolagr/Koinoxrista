import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { AllocationStrategy } from '@prisma/client';

import { AuthenticatedUser } from '../auth/auth.types';
import { assertSameBuilding } from '../common/tenant';
import { PrismaService } from '../prisma/prisma.service';
import { assertSupportedAllocationStrategy } from '../expenses/allocation-weights';
import { CreateExpenseCategoryDto } from './dto/create-expense-category.dto';

@Injectable()
export class ExpenseCategoriesService {
  constructor(private readonly prisma: PrismaService) {}

  async create(
    buildingId: string,
    dto: CreateExpenseCategoryDto,
    user: AuthenticatedUser,
  ) {
    assertSameBuilding(user, buildingId);
    const strategy = dto.strategy ?? AllocationStrategy.MILIMES;
    // There is no persisted custom weight map.  Reject CUSTOM (and any
    // unknown strategy) before creating a category that can never be billed.
    try {
      assertSupportedAllocationStrategy(strategy);
    } catch (error) {
      if (error instanceof BadRequestException) throw error;
      throw new BadRequestException('Unsupported allocation strategy');
    }
    await this.requireBuilding(buildingId);

    return this.prisma.expenseCategory.create({
      data: {
        buildingId,
        name: dto.name,
        strategy,
      },
    });
  }

  async list(buildingId: string, user: AuthenticatedUser) {
    assertSameBuilding(user, buildingId);
    await this.requireBuilding(buildingId);

    return this.prisma.expenseCategory.findMany({
      where: { buildingId },
      orderBy: { name: 'asc' },
    });
  }

  private async requireBuilding(buildingId: string): Promise<void> {
    const building = await this.prisma.building.findUnique({
      where: { id: buildingId },
    });
    if (!building) {
      throw new NotFoundException('Building not found');
    }
  }
}

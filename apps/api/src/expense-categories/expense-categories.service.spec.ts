import { BadRequestException } from '@nestjs/common';
import { AllocationStrategy } from '@prisma/client';

import type { AuthenticatedUser } from '../auth/auth.types';
import { PrismaService } from '../prisma/prisma.service';
import { ExpenseCategoriesService } from './expense-categories.service';

const user: AuthenticatedUser = {
  id: 'admin-1',
  email: 'admin@example.gr',
  role: 'ADMIN',
  buildingId: 'building-1',
};

describe('expense category allocation configuration', () => {
  it('rejects CUSTOM before creating a category', async () => {
    const prisma = {
      building: { findUnique: jest.fn().mockResolvedValue({ id: 'building-1' }) },
      expenseCategory: { create: jest.fn() },
    };
    const service = new ExpenseCategoriesService(
      prisma as unknown as PrismaService,
    );

    await expect(
      service.create(
        'building-1',
        { name: 'Custom', strategy: AllocationStrategy.CUSTOM },
        user,
      ),
    ).rejects.toThrow(BadRequestException);
    expect(prisma.expenseCategory.create).not.toHaveBeenCalled();
    expect(prisma.building.findUnique).not.toHaveBeenCalled();
  });

  it.each([
    AllocationStrategy.MILIMES,
    AllocationStrategy.UNITS,
    AllocationStrategy.RADIATORS,
    AllocationStrategy.ELEVATOR_FLOORS,
    AllocationStrategy.METERS,
    AllocationStrategy.SQUARE_METERS,
    AllocationStrategy.SHARE_FRACTION,
    AllocationStrategy.HEADCOUNT,
  ])('accepts implemented strategy %s', async (strategy) => {
    const prisma = {
      building: { findUnique: jest.fn().mockResolvedValue({ id: 'building-1' }) },
      expenseCategory: {
        create: jest.fn().mockResolvedValue({ id: 'category-1' }),
      },
    };
    const service = new ExpenseCategoriesService(
      prisma as unknown as PrismaService,
    );

    await expect(
      service.create('building-1', { name: 'Valid', strategy }, user),
    ).resolves.toMatchObject({ id: 'category-1' });
  });
});

import { BadRequestException } from '@nestjs/common';
import { Role } from '@prisma/client';

import { AuditService } from '../audit/audit.service';
import type { AuthenticatedUser } from '../auth/auth.types';
import { PrismaService } from '../prisma/prisma.service';
import { ExcelImportService } from './excel-import.service';

const user: AuthenticatedUser = {
  id: 'admin-1',
  email: 'admin@example.gr',
  role: Role.ADMIN,
  buildingId: 'building-1',
};
const csv = (body: string) => Buffer.from(body, 'utf8').toString('base64');

describe('confirmed Excel unit imports', () => {
  it('validates the projected building total before any write', async () => {
    const prisma = {
      unit: {
        findMany: jest.fn().mockResolvedValue([]),
        create: jest.fn(),
        update: jest.fn(),
      },
      $transaction: jest.fn(),
    };
    const service = new ExcelImportService(
      prisma as unknown as PrismaService,
      { record: jest.fn() } as unknown as AuditService,
    );

    await expect(
      service.importUnits(
        'building-1',
        {
          filename: 'units.csv',
          contentBase64: csv('label;millimes\nA;600\nB;500'),
          confirm: true,
        },
        user,
      ),
    ).rejects.toThrow(BadRequestException);
    expect(prisma.unit.create).not.toHaveBeenCalled();
    expect(prisma.unit.update).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('commits all valid upserts through one transaction', async () => {
    const prisma = {
      unit: {
        findMany: jest.fn().mockResolvedValue([]),
        create: jest.fn().mockResolvedValue({ id: 'unit-a' }),
        update: jest.fn(),
      },
      $transaction: jest.fn(async (operations: Promise<unknown>[]) =>
        Promise.all(operations),
      ),
    };
    const service = new ExcelImportService(
      prisma as unknown as PrismaService,
      { record: jest.fn() } as unknown as AuditService,
    );

    await expect(
      service.importUnits(
        'building-1',
        {
          filename: 'units.csv',
          contentBase64: csv('label;millimes\nA;600\nB;400'),
          confirm: true,
        },
        user,
      ),
    ).resolves.toEqual({ created: 2, updated: 0 });
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
  });
});

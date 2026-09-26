import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';

import { AuthenticatedUser } from '../auth/auth.types';
import { assertSameBuilding } from '../common/tenant';
import { PrismaService } from '../prisma/prisma.service';
import {
  effectiveOwnershipWhere,
  endOfBillingYear,
  isEffectiveOwnership,
  ownershipWindowWhere,
  overlapsOwnershipPeriod,
  requireActiveBuildingId,
} from '../ownerships/ownership-scope';
import { ArrearsService } from '../payments/arrears.service';
import { buildLedgerRows, ledgerTotals } from './build-ledger';
import { toCsv } from './csv';
import { renderReceiptHtml } from './render-receipt';
import {
  UnitYearStatement,
  buildUnitStatement,
  ownerDisplayName,
} from './statements';

export interface CsvFile {
  body: string;
  contentType: string;
  filename: string;
}

const YEAR_REGEX = /^\d{4}$/;

@Injectable()
export class ExportsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly arrearsService: ArrearsService,
  ) {}

  async ledgerCsv(
    buildingId: string,
    year: string | undefined,
    user: AuthenticatedUser,
  ): Promise<CsvFile> {
    assertSameBuilding(user, buildingId);
    if (!year || !YEAR_REGEX.test(year)) {
      throw new BadRequestException('year must match YYYY');
    }

    const [expenses, units, invoices] = await Promise.all([
      this.prisma.expense.findMany({
        where: { buildingId, periodYearMonth: { startsWith: `${year}-` } },
        include: { shares: true },
      }),
      this.prisma.unit.findMany({ where: { buildingId } }),
      this.prisma.invoice.findMany({
        where: { buildingId, periodYearMonth: { startsWith: `${year}-` } },
      }),
    ]);

    const rows = buildLedgerRows(year, expenses, units, invoices);
    const totals = ledgerTotals(rows);
    const body = toCsv(
      ['periodYearMonth', 'unitLabel', 'description', 'invoicedCents', 'paidCents', 'balanceCents'],
      [
        ...rows.map((row) => [
          row.periodYearMonth,
          row.unitLabel,
          row.description,
          row.invoicedCents,
          row.paidCents,
          row.balanceCents,
        ]),
        ['ΣΥΝΟΛΟ', '', '', totals.invoicedCents, totals.paidCents, totals.balanceCents],
      ],
    );
    return {
      body,
      contentType: 'text/csv;charset=utf-8',
      filename: `koinoxrista-${year}.csv`,
    };
  }

  async arrearsCsv(
    buildingId: string,
    user: AuthenticatedUser,
    now: Date = new Date(),
  ): Promise<CsvFile> {
    const report = await this.arrearsService.getArrears(buildingId, user, now);
    const body = toCsv(
      [
        'unitId',
        'unitLabel',
        'ownerNames',
        'outstandingCents',
        'bucketCurrentCents',
        'bucket30Cents',
        'bucket60Cents',
        'bucket90PlusCents',
        'oldestUnpaidPeriod',
      ],
      [
        ...report.rows.map((row) => [
          row.unitId,
          row.unitLabel,
          row.ownerNames.join(', '),
          row.outstandingCents,
          row.bucketCurrentCents,
          row.bucket30Cents,
          row.bucket60Cents,
          row.bucket90PlusCents,
          row.oldestUnpaidPeriod ?? '',
        ]),
        [
          'ΣΥΝΟΛΟ',
          '',
          '',
          report.totalOutstandingCents,
          report.rows.reduce((sum, row) => sum + row.bucketCurrentCents, 0),
          report.rows.reduce((sum, row) => sum + row.bucket30Cents, 0),
          report.rows.reduce((sum, row) => sum + row.bucket60Cents, 0),
          report.rows.reduce((sum, row) => sum + row.bucket90PlusCents, 0),
          '',
        ],
      ],
    );
    const date = now.toISOString().slice(0, 10);
    return {
      body,
      contentType: 'text/csv;charset=utf-8',
      filename: `koinoxrista-arrears-${date}.csv`,
    };
  }

  async receiptHtml(invoiceId: string, user: AuthenticatedUser): Promise<CsvFile> {
    const invoice = await this.prisma.invoice.findUnique({
      where: { id: invoiceId },
      include: {
        payments: { orderBy: { createdAt: 'asc' } },
        unit: { include: { building: { select: { name: true } } } },
      },
    });
    if (!invoice) {
      throw new NotFoundException('Invoice not found');
    }
    await this.assertReceiptAccess(invoice.buildingId, invoice.unitId, user);

    return {
      body: renderReceiptHtml({
        buildingName: invoice.unit.building.name,
        unitLabel: invoice.unit.label,
        periodYearMonth: invoice.periodYearMonth,
        totalCents: invoice.totalCents,
        paidCents: invoice.paidCents,
        payments: invoice.payments.map((payment) => ({
          createdAt: payment.createdAt,
          method: payment.method,
          pspRef: payment.pspRef,
          amountCents: payment.amountCents,
        })),
        generatedAt: new Date(),
      }),
      contentType: 'text/html;charset=utf-8',
      filename: `apodeiksi-${invoice.periodYearMonth}-${invoice.unit.label}.html`,
    };
  }

  async unitStatement(
    buildingId: string,
    unitId: string,
    year: string,
    user: AuthenticatedUser,
  ): Promise<UnitYearStatement> {
    assertSameBuilding(user, buildingId);
    if (!YEAR_REGEX.test(year)) {
      throw new BadRequestException('year must match YYYY');
    }
    const building = await this.prisma.building.findUnique({
      where: { id: buildingId },
      select: { name: true },
    });
    if (!building) {
      throw new NotFoundException('Building not found');
    }
    const unit = await this.prisma.unit.findFirst({
      where: { id: unitId, buildingId },
      select: { id: true, label: true },
    });
    if (!unit) {
      throw new NotFoundException('Unit not found');
    }
    return this.buildStatement(
      buildingId,
      building.name,
      unit.id,
      unit.label,
      year,
    );
  }

  async myUnitStatement(
    year: string,
    user: AuthenticatedUser,
    unitId?: string,
  ): Promise<UnitYearStatement> {
    if (!YEAR_REGEX.test(year)) {
      throw new BadRequestException('year must match YYYY');
    }
    const buildingId = requireActiveBuildingId(user);
    const at = endOfBillingYear(year);
    const ownerships = await this.prisma.ownership.findMany({
      where: effectiveOwnershipWhere(user.id, buildingId, at),
    });
    const ownedUnitIds = [
      ...new Set(
        ownerships
          .filter((ownership) => isEffectiveOwnership(ownership, at))
          .map((ownership) => ownership.unitId),
      ),
    ];
    if (ownedUnitIds.length === 0) {
      throw new ForbiddenException('User has no effective ownership in the active building');
    }
    if (unitId && !ownedUnitIds.includes(unitId)) {
      throw new ForbiddenException('You do not own the requested unit');
    }
    if (!unitId && ownedUnitIds.length > 1) {
      throw new BadRequestException(
        'Multiple units are owned; specify unitId for the statement',
      );
    }

    const [onlyOwnedUnitId] = ownedUnitIds;
    const selectedUnitId = unitId ?? onlyOwnedUnitId;
    if (!selectedUnitId) {
      throw new ForbiddenException('User has no effective ownership in the active building');
    }
    const units = await this.prisma.unit.findMany({
      where: { id: selectedUnitId, buildingId },
      orderBy: { label: 'asc' },
      select: { id: true, label: true, buildingId: true },
    });
    const unit = units.find((candidate) => candidate.id === selectedUnitId);
    if (!unit) {
      throw new ForbiddenException('The owned unit is not in the active building');
    }
    const building = await this.prisma.building.findUnique({
      where: { id: buildingId },
      select: { name: true },
    });
    if (!building) {
      throw new NotFoundException('Building not found');
    }
    return this.buildStatement(
      buildingId,
      building.name,
      unit.id,
      unit.label,
      year,
    );
  }

  private async buildStatement(
    buildingId: string,
    buildingName: string,
    unitId: string,
    unitLabel: string,
    year: string,
  ): Promise<UnitYearStatement> {
    const [expenses, invoices, ownerships] = await Promise.all([
      this.prisma.expense.findMany({
        where: { buildingId, periodYearMonth: { startsWith: `${year}-` } },
        include: { shares: true },
        orderBy: [{ periodYearMonth: 'asc' }, { description: 'asc' }],
      }),
      this.prisma.invoice.findMany({
        where: { buildingId, unitId, periodYearMonth: { startsWith: `${year}-` } },
        select: { unitId: true, periodYearMonth: true, paidCents: true },
      }),
      this.prisma.ownership.findMany({
        where: ownershipWindowWhere(
          unitId,
          buildingId,
          new Date(Date.UTC(Number(year), 0, 1, 0, 0, 0, 0)),
          endOfBillingYear(year),
        ),
        include: { user: { select: { firstName: true, lastName: true } } },
      }),
    ]);
    const from = new Date(Date.UTC(Number(year), 0, 1, 0, 0, 0, 0));
    const to = endOfBillingYear(year);
    const visibleOwners = ownerships.filter((ownership) =>
      overlapsOwnershipPeriod(
        ownership as typeof ownership & {
          periodStart?: Date | null;
          periodEnd?: Date | null;
        },
        from,
        to,
      ),
    );
    return buildUnitStatement({
      buildingName,
      unitId,
      unitLabel,
      ownerName: ownerDisplayName(visibleOwners.map((o) => o.user)),
      year,
      expenses,
      invoices,
    });
  }

  private async assertReceiptAccess(
    buildingId: string,
    unitId: string,
    user: AuthenticatedUser,
  ): Promise<void> {
    assertSameBuilding(user, buildingId);
    if (user.role === 'ADMIN' || user.role === 'BUILDING_OWNER') return;
    const at = new Date();
    const ownership = await this.prisma.ownership.findFirst({
      where: effectiveOwnershipWhere(user.id, buildingId, at, unitId),
    });
    const owns = Boolean(
      ownership &&
        isEffectiveOwnership(ownership as typeof ownership & {
          periodStart?: Date | null;
          periodEnd?: Date | null;
        }, at),
    );
    if (!owns) {
      throw new ForbiddenException('You do not have an effective ownership of this unit');
    }
  }
}

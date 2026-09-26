import { BadRequestException, Injectable } from '@nestjs/common';
import { TOTAL_MILLIMES } from '@org/shared';
import type {
  UnitImportPreviewDto,
  UnitImportRequestDto,
  UnitImportResultDto,
} from '@org/shared';

import type { AuthenticatedUser } from '../auth/auth.types';
import { AuditService } from '../audit/audit.service';
import { assertSameBuilding } from '../common/tenant';
import { PrismaService } from '../prisma/prisma.service';
import {
  mapUnitsColumns,
  normalizeUnitLabel,
  parseUnitsSheet,
  readSheetRows,
} from './parse-units-sheet';

@Injectable()
export class ExcelImportService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /**
   * Dry-run preview or confirmed upsert of Units by label (case-insensitive
   * trim). Without `confirm` nothing is written; invalid rows never reach the
   * database in either mode.
   */
  async importUnits(
    buildingId: string,
    dto: UnitImportRequestDto,
    user: AuthenticatedUser,
  ): Promise<UnitImportPreviewDto | UnitImportResultDto> {
    assertSameBuilding(user, buildingId);
    const parsed = await this.parseUpload(dto);

    if (!dto.confirm) {
      return parsed;
    }

    const existing = await this.prisma.unit.findMany({
      where: { buildingId },
      select: { id: true, label: true, millimes: true },
    });
    const byLabelKey = new Map(
      existing.map((unit) => [normalizeUnitLabel(unit.label), unit]),
    );
    if (byLabelKey.size !== existing.length) {
      throw new BadRequestException(
        'The building contains duplicate unit labels ignoring case; import cannot choose an upsert target',
      );
    }

    const validRows = parsed.rows
      .filter(
        (row) => row.errors.length === 0 && row.label && row.millimes != null,
      )
      .map((row) => ({ ...row, millimes: row.millimes as number }));
    if (parsed.rows.length > 0 && validRows.length === 0) {
      throw new BadRequestException('The import contains no valid unit rows');
    }
    for (const row of validRows) {
      if (
        !Number.isSafeInteger(row.millimes) ||
        row.millimes < 1 ||
        row.millimes > TOTAL_MILLIMES
      ) {
        throw new BadRequestException(
          `Unit ${row.label} has invalid millimes; each unit must be between 1 and ${TOTAL_MILLIMES}`,
        );
      }
      if (
        row.radiatorCount != null &&
        (!Number.isSafeInteger(row.radiatorCount) || row.radiatorCount < 0)
      ) {
        throw new BadRequestException(
          `Unit ${row.label} has an invalid radiator count`,
        );
      }
    }

    // Apply the complete upsert set in one transaction.  Before writing,
    // calculate the resulting building total, including units omitted from a
    // partial sheet.  A confirmed import may stage an incomplete building,
    // but it may never push the 1000‰ budget over the limit.
    if (
      existing.some(
        (unit) =>
          unit.millimes !== undefined &&
          (!Number.isSafeInteger(unit.millimes) || unit.millimes < 0),
      )
    ) {
      throw new BadRequestException(
        'Existing units contain invalid millimes; repair them before importing',
      );
    }
    const projectedById = new Map(
      existing.map((unit) => [unit.id, unit.millimes ?? 0]),
    );
    const projectedByLabel = new Map(byLabelKey);
    for (const row of validRows) {
      const key = normalizeUnitLabel(row.label);
      const current = projectedByLabel.get(key);
      const millimes = row.millimes;
      if (current) projectedById.set(current.id, millimes);
      else {
        projectedByLabel.set(key, {
          id: `new:${key}`,
          label: row.label,
          millimes,
        });
      }
    }
    const projectedTotal = [...projectedById.values()].reduce(
      (sum, value) => sum + value,
      0,
    ) +
      [...projectedByLabel.values()]
        .filter((unit) => unit.id.startsWith('new:'))
        .reduce((sum, unit) => sum + unit.millimes, 0);
    if (projectedTotal > TOTAL_MILLIMES) {
      throw new BadRequestException(
        `The confirmed import would leave ${projectedTotal} millimes; the building maximum is ${TOTAL_MILLIMES}`,
      );
    }

    const operations: Promise<unknown>[] = [];
    let created = 0;
    let updated = 0;
    for (const row of validRows) {
      const key = normalizeUnitLabel(row.label);
      const current = byLabelKey.get(key);
      if (current) {
        operations.push(
          this.prisma.unit.update({
            where: { id: current.id },
            data: {
              ...(row.floor != null ? { floor: row.floor } : {}),
              millimes: row.millimes,
              ...(row.radiatorCount != null
                ? { radiatorCount: row.radiatorCount }
                : {}),
            },
          }),
        );
        updated++;
      } else {
        operations.push(
          this.prisma.unit.create({
            data: {
              buildingId,
              label: row.label,
              floor: row.floor,
              millimes: row.millimes,
              radiatorCount: row.radiatorCount ?? 0,
            },
          }),
        );
        created++;
      }
    }

    const transaction = (
      this.prisma as unknown as {
        $transaction?: (operations: Promise<unknown>[]) => Promise<unknown>;
      }
    ).$transaction;
    if (transaction) {
      await transaction.call(this.prisma, operations);
    } else {
      // This branch is only useful for lightweight unit-test doubles; the
      // real PrismaService always exposes the atomic transaction method.
      await Promise.all(operations);
    }

    this.audit.record({
      buildingId,
      actorId: user.id,
      actorRole: user.role,
      action: 'unit.excel-import',
      entity: 'unit',
      entityId: null,
      metadata: {
        filename: dto.filename,
        created,
        updated,
        skippedErrors: parsed.errorCount,
        totalMillimes: parsed.totalMillimes,
      },
    });

    return { created, updated };
  }

  /** Decodes + parses the upload; unreadable files map to 400. */
  private async parseUpload(dto: UnitImportRequestDto) {
    let buffer: Buffer;
    try {
      buffer = Buffer.from(dto.contentBase64, 'base64');
    } catch {
      throw new BadRequestException('Μη έγκυρη κωδικοποίηση base64.');
    }
    if (buffer.length === 0) {
      throw new BadRequestException('Το αρχείο είναι κενό.');
    }

    let table: string[][];
    try {
      table = await readSheetRows(buffer, dto.filename ?? '');
    } catch {
      throw new BadRequestException(
        'Μη αναγνώσιμο αρχείο. Περιμένουμε .xlsx ή .csv με στήλες διαμερισμάτων.',
      );
    }
    if (table.length === 0) {
      throw new BadRequestException('Το αρχείο δεν περιέχει γραμμές.');
    }

    const columns = mapUnitsColumns(table[0]);
    if (!columns) {
      throw new BadRequestException(
        'Δεν βρέθηκε στήλη ετικέτας (Διαμέρισμα/Apartment/label/Κωδικός).',
      );
    }
    return parseUnitsSheet(table, columns);
  }
}

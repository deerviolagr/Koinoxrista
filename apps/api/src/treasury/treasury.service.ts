import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';

import type { AuthenticatedUser } from '../auth/auth.types';
import { AuditService } from '../audit/audit.service';
import { assertSameBuilding } from '../common/tenant';
import { PrismaService } from '../prisma/prisma.service';
import { CreateTreasuryAccountDto } from './dto/create-treasury-account.dto';
import { CreateTreasuryEntryDto } from './dto/create-treasury-entry.dto';

// These types mirror the Prisma models before `prisma generate` for treasury.
// Using string unions keeps the service independently type-safe.
type TreasuryAccountType = 'CASH' | 'BANK';
type TreasuryDirection = 'IN' | 'OUT';
type TreasuryMethod = 'CASH' | 'BANK' | 'CHECK' | 'CARD';

const ACCOUNT_TYPES: readonly string[] = ['CASH', 'BANK'];
const DIRECTIONS: readonly string[] = ['IN', 'OUT'];
const METHODS: readonly string[] = ['CASH', 'BANK', 'CHECK', 'CARD'];

const DEFAULT_TAKE = 25;
const MAX_TAKE = 100;

function isUniqueConflict(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: string }).code === 'P2002'
  );
}

function parseDateFilter(raw: string, endOfDay: boolean): Date {
  const value = raw.trim();
  // HTML date inputs send YYYY-MM-DD.  new Date('2026-12-31') is midnight
  // and would silently exclude the rest of that day.
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const [year, month, day] = value.split('-').map(Number);
    const parsed = new Date(
      `${value}T${endOfDay ? '23:59:59.999' : '00:00:00.000'}Z`,
    );
    if (
      Number.isNaN(parsed.getTime()) ||
      parsed.getUTCFullYear() !== year ||
      parsed.getUTCMonth() + 1 !== month ||
      parsed.getUTCDate() !== day
    ) {
      throw new BadRequestException(endOfDay ? 'Invalid to date' : 'Invalid from date');
    }
    return parsed;
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new BadRequestException(endOfDay ? 'Invalid to date' : 'Invalid from date');
  }
  return parsed;
}

@Injectable()
export class TreasuryService {
  /** Serialises same-reference requests inside one API process. */
  private readonly referenceLocks = new Map<string, Promise<void>>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  // ---------------------------------------------------------------------------
  // Accounts
  // ---------------------------------------------------------------------------

  async listAccounts(buildingId: string, user: AuthenticatedUser) {
    assertSameBuilding(user, buildingId);
    const prismaAny = this.prisma as unknown as Record<string, any>;
    return prismaAny.treasuryAccount.findMany({
      where: { buildingId },
      orderBy: { createdAt: 'asc' },
    });
  }

  async createAccount(
    buildingId: string,
    dto: CreateTreasuryAccountDto,
    user: AuthenticatedUser,
  ) {
    assertSameBuilding(user, buildingId);
    if (!ACCOUNT_TYPES.includes(dto.type)) {
      throw new BadRequestException('type must be CASH or BANK');
    }
    if (
      dto.iban !== undefined &&
      dto.iban !== null &&
      dto.iban.trim() !== '' &&
      dto.type !== 'BANK'
    ) {
      // IBAN only makes sense for BANK accounts but allow it for CASH if provided
      // — silently keep it; or we could reject. We allow but warn via trimming.
    }
    const prismaAny = this.prisma as unknown as Record<string, any>;
    try {
      const account = await prismaAny.treasuryAccount.create({
        data: {
          buildingId,
          name: dto.name.trim(),
          type: dto.type,
          ...(dto.iban !== undefined && dto.iban.trim() !== ''
            ? { iban: dto.iban.trim() }
            : {}),
        },
      });
      this.audit.record({
        buildingId,
        actorId: user.id,
        actorRole: user.role,
        action: 'treasury.account.created',
        entity: 'treasury_account',
        entityId: account.id,
        metadata: { name: account.name, type: account.type },
      });
      return account;
    } catch (error) {
      if (isUniqueConflict(error)) {
        throw new ConflictException('An account with this name already exists in the building');
      }
      throw error;
    }
  }

  // ---------------------------------------------------------------------------
  // Entries
  // ---------------------------------------------------------------------------

  async listEntries(
    buildingId: string,
    user: AuthenticatedUser,
    filters: {
      accountId?: string;
      from?: string;
      to?: string;
      skip?: string | number;
      take?: string | number;
    } = {},
  ): Promise<{ items: any[]; total: number }> {
    assertSameBuilding(user, buildingId);
    const prismaAny = this.prisma as unknown as Record<string, any>;

    const where: Record<string, unknown> = { buildingId };

    if (filters.accountId) {
      // Ensure account belongs to building for isolation check; if not found return empty
      const account = await prismaAny.treasuryAccount.findFirst({
        where: { id: filters.accountId, buildingId },
      });
      if (!account) {
        throw new NotFoundException('Treasury account not found');
      }
      (where as any).accountId = filters.accountId;
    }

    const createdAt: Record<string, Date> = {};
    if (filters.from) {
      createdAt.gte = parseDateFilter(filters.from, false);
    }
    if (filters.to) {
      createdAt.lte = parseDateFilter(filters.to, true);
    }
    if (
      createdAt.gte &&
      createdAt.lte &&
      createdAt.gte.getTime() > createdAt.lte.getTime()
    ) {
      throw new BadRequestException('from must be before or equal to to');
    }
    if (Object.keys(createdAt).length > 0) {
      (where as any).createdAt = createdAt;
    }

    const take = Math.min(
      Math.max(Number(filters.take ?? DEFAULT_TAKE) || DEFAULT_TAKE, 1),
      MAX_TAKE,
    );
    const skip = Math.max(Number(filters.skip ?? 0) || 0, 0);

    const [items, total] = await (this.prisma as any).$transaction([
      prismaAny.treasuryEntry.findMany({
        where,
        include: { account: { select: { name: true } } },
        orderBy: { createdAt: 'desc' },
        skip,
        take,
      }),
      prismaAny.treasuryEntry.count({ where }),
    ]);

    // Enrich with accountName for list views
    const enriched = items.map((e: any) => ({
      ...e,
      accountName: e.account?.name ?? null,
      createdAt: e.createdAt instanceof Date ? e.createdAt.toISOString() : e.createdAt,
    }));

    return { items: enriched, total };
  }

  async createEntry(
    buildingId: string,
    dto: CreateTreasuryEntryDto,
    user: AuthenticatedUser,
  ) {
    assertSameBuilding(user, buildingId);

    if (!DIRECTIONS.includes(dto.direction)) {
      throw new BadRequestException('direction must be IN or OUT');
    }
    if (!METHODS.includes(dto.method)) {
      throw new BadRequestException('method must be CASH, BANK, CHECK or CARD');
    }
    if (!Number.isInteger(dto.amountCents) || dto.amountCents === 0) {
      throw new BadRequestException('amountCents must be a non-zero integer (cents)');
    }
    if (dto.direction === 'IN' && dto.amountCents < 0) {
      throw new BadRequestException('IN entries must have positive amountCents');
    }
    if (dto.direction === 'OUT' && dto.amountCents > 0) {
      throw new BadRequestException('OUT entries must have negative amountCents');
    }

    const prismaAny = this.prisma as unknown as Record<string, any>;

    // Isolation: account must belong to the same building.
    const account = await prismaAny.treasuryAccount.findFirst({
      where: { id: dto.accountId, buildingId },
    });
    if (!account) {
      throw new NotFoundException('Treasury account not found in this building');
    }

    const reference = dto.reference?.trim() ?? '';
    const lockKey = reference
      ? `${buildingId}:${dto.accountId}:${reference.toUpperCase()}`
      : '';

    const create = async (): Promise<{ entry: any; created: boolean }> =>
      (this.prisma as any).$transaction(
        async (tx: Record<string, any>) => {
          const entryDelegate = tx.treasuryEntry ?? prismaAny.treasuryEntry;
          const accountDelegate = tx.treasuryAccount ?? prismaAny.treasuryAccount;
          const findEntry = entryDelegate.findFirst
            ? () => entryDelegate.findFirst({
                where: {
                  buildingId,
                  accountId: dto.accountId,
                  reference,
                },
              })
            : prismaAny.treasuryEntry?.findFirst
              ? () => prismaAny.treasuryEntry.findFirst({
                  where: {
                    buildingId,
                    accountId: dto.accountId,
                    reference,
                  },
                })
              : undefined;

          // `reference` is the only durable idempotency field in the current
          // schema.  Do not guess for entries without one; a same-reference
          // request with different money is a conflict, not a second entry.
          if (reference && findEntry) {
            const existing = await findEntry();
            if (existing) {
              if (
                existing.amountCents !== dto.amountCents ||
                existing.direction !== dto.direction ||
                existing.method !== dto.method
              ) {
                throw new ConflictException(
                  'Treasury reference was already used for a different entry',
                );
              }
              return { entry: existing, created: false };
            }
          }

          const created = await entryDelegate.create({
            data: {
              accountId: dto.accountId,
              buildingId,
              amountCents: dto.amountCents,
              direction: dto.direction,
              method: dto.method,
              ...(reference ? { reference } : {}),
              ...(dto.notes !== undefined && dto.notes.trim() !== ''
                ? { notes: dto.notes.trim() }
                : {}),
              ...(dto.receiptUrl !== undefined && dto.receiptUrl.trim() !== ''
                ? { receiptUrl: dto.receiptUrl.trim() }
                : {}),
              ...(user.id ? { createdById: user.id } : {}),
            },
          });

          if (accountDelegate.updateMany) {
            const updated = await accountDelegate.updateMany({
              where: { id: dto.accountId, buildingId },
              data: { balanceCents: { increment: dto.amountCents } },
            });
            if (!updated || updated.count === 0) {
              throw new NotFoundException('Treasury account not found in this building');
            }
          } else {
            await accountDelegate.update({
              where: { id: dto.accountId },
              data: { balanceCents: { increment: dto.amountCents } },
            });
          }
          return { entry: created, created: true };
        },
        // Serializable makes the reference check safe across API instances;
        // the in-process lock below avoids needless serialization conflicts.
        { isolationLevel: 'Serializable' as any },
      );

    const result = lockKey ? await this.withReferenceLock(lockKey, create) : await create();
    if (!result.created) return result.entry;

    this.audit.record({
      buildingId,
      actorId: user.id,
      actorRole: user.role,
      action: 'treasury.entry.created',
      entity: 'treasury_entry',
      entityId: result.entry.id,
      metadata: {
        accountId: dto.accountId,
        amountCents: dto.amountCents,
        direction: dto.direction,
        method: dto.method,
      },
    });

    return result.entry;
  }

  private async withReferenceLock<T>(
    key: string,
    work: () => Promise<T>,
  ): Promise<T> {
    const previous = this.referenceLocks.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const queued = previous.then(() => current);
    this.referenceLocks.set(key, queued);
    await previous;
    try {
      return await work();
    } finally {
      release();
      if (this.referenceLocks.get(key) === queued) {
        this.referenceLocks.delete(key);
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Balance / KPIs
  // ---------------------------------------------------------------------------

  async getBalance(buildingId: string, user: AuthenticatedUser) {
    assertSameBuilding(user, buildingId);
    const prismaAny = this.prisma as unknown as Record<string, any>;

    const [accounts, entries] = await Promise.all([
      prismaAny.treasuryAccount.findMany({
        where: { buildingId },
        orderBy: { createdAt: 'asc' },
      }),
      prismaAny.treasuryEntry.findMany({
        where: { buildingId },
        select: { amountCents: true, direction: true, createdAt: true, accountId: true },
        orderBy: { createdAt: 'asc' },
      }),
    ]);

    let totalCents = 0;
    let cashCents = 0;
    let bankCents = 0;
    const byAccount = accounts.map((a: any) => {
      totalCents += a.balanceCents ?? 0;
      if (a.type === 'CASH') cashCents += a.balanceCents ?? 0;
      if (a.type === 'BANK') bankCents += a.balanceCents ?? 0;
      return {
        accountId: a.id,
        name: a.name,
        type: a.type as TreasuryAccountType,
        balanceCents: a.balanceCents ?? 0,
      };
    });

    // Monthly IN/OUT totals for chart (YYYY-MM ascending)
    const monthMap = new Map<string, { inCents: number; outCents: number }>();
    for (const e of entries as Array<{ amountCents: number; direction: string; createdAt: Date }>) {
      const d = e.createdAt instanceof Date ? e.createdAt : new Date(e.createdAt);
      const month = d.toISOString().slice(0, 7); // YYYY-MM
      const bucket = monthMap.get(month) ?? { inCents: 0, outCents: 0 };
      if (e.direction === 'IN' || e.amountCents > 0) {
        bucket.inCents += Math.abs(e.amountCents);
      } else {
        bucket.outCents += Math.abs(e.amountCents);
      }
      monthMap.set(month, bucket);
    }

    const byMonth = [...monthMap.entries()]
      .map(([month, v]) => ({
        month,
        inCents: v.inCents,
        outCents: v.outCents,
        netCents: v.inCents - v.outCents,
      }))
      .sort((a, b) => a.month.localeCompare(b.month));

    return {
      totalCents,
      cashCents,
      bankCents,
      byAccount,
      byMonth,
    };
  }
}

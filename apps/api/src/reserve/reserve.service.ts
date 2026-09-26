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
import { splitByLargestRemainder } from '../prisma/split-by-largest-remainder';
import { AllocationStrategy } from '@prisma/client';

import { resolveAllocationWeights } from '../expenses/allocation-weights';
import { ContributionDto } from './dto/contribution.dto';
import { CreateLevyDto } from './dto/create-levy.dto';
import { DrawdownDto } from './dto/drawdown.dto';

const LEVY_STATUSES = {
  DRAFT: 'DRAFT',
  ISSUED: 'ISSUED',
  CLOSED: 'CLOSED',
} as const;

const ALLOWED_STRATEGIES = [
  'MILIMES',
  'UNITS',
  'CUSTOM',
  'SQUARE_METERS',
  'SHARE_FRACTION',
] as const;

function isUniqueConflict(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: string }).code === 'P2002'
  );
}

@Injectable()
export class ReserveService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  // -------------------------------------------------------------------------
  // Fund
  // -------------------------------------------------------------------------

  async getOrCreateFund(buildingId: string, user?: AuthenticatedUser) {
    if (user) assertSameBuilding(user, buildingId);
    const prismaAny = this.prisma as unknown as Record<string, any>;

    let fund = await prismaAny.reserveFund.findUnique({
      where: { buildingId },
    });
    if (fund) return fund;

    // Create with defaults; handle race where unique constraint fires
    try {
      fund = await prismaAny.reserveFund.create({
        data: { buildingId, targetCents: 0, balanceCents: 0 },
      });
      return fund;
    } catch (error) {
      // If unique violation (another request created), fetch again
      if (isUniqueConflict(error)) {
        fund = await prismaAny.reserveFund.findUnique({
          where: { buildingId },
        });
        if (fund) return fund;
      }
      throw error;
    }
  }

  async updateTarget(
    buildingId: string,
    targetCents: number,
    user: AuthenticatedUser,
  ) {
    assertSameBuilding(user, buildingId);
    if (!Number.isInteger(targetCents) || targetCents < 0) {
      throw new BadRequestException('targetCents must be a non-negative integer');
    }
    const prismaAny = this.prisma as unknown as Record<string, any>;
    const fund = await this.getOrCreateFund(buildingId, user);

    const updated = await prismaAny.reserveFund.update({
      where: { id: fund.id },
      data: { targetCents },
    });

    this.audit.record({
      buildingId,
      actorId: user.id,
      actorRole: user.role,
      action: 'reserve.fund.target_updated',
      entity: 'reserve_fund',
      entityId: updated.id,
      metadata: { targetCents },
    });

    return updated;
  }

  /**
   * Records cash actually received into the reserve fund.
   *
   * A LEVY contribution is deliberately different from issuance: it is a
   * collection against an issued receivable.  It is allocated to unpaid
   * LevyShare rows and can only increase the fund by the amount successfully
   * allocated.  Issuing a levy itself never creates cash (see issueLevy).
   */
  async contribute(
    buildingId: string,
    dto: ContributionDto,
    user: AuthenticatedUser,
  ) {
    assertSameBuilding(user, buildingId);
    if (!Number.isInteger(dto.amountCents) || dto.amountCents <= 0) {
      throw new BadRequestException('amountCents must be a positive integer');
    }

    if (dto.source === 'LEVY') {
      if (!dto.levyId) {
        throw new BadRequestException('levyId is required for a LEVY collection');
      }
      return this.collectLevy(
        buildingId,
        dto.levyId,
        dto.amountCents,
        user,
        (dto as ContributionDto & { unitId?: string }).unitId,
      );
    }
    if (dto.levyId) {
      throw new BadRequestException('levyId is only valid for a LEVY collection');
    }

    const fund = await this.getOrCreateFund(buildingId, user);

    const result = await (this.prisma as any).$transaction(
      async (tx: Record<string, any>) => {
        const contribution = await tx.reserveContribution.create({
          data: {
            fundId: fund.id,
            buildingId,
            amountCents: dto.amountCents,
            source: dto.source,
            ...(dto.notes ? { notes: dto.notes } : {}),
          },
        });
        const updatedFund = await tx.reserveFund.update({
          where: { id: fund.id },
          data: { balanceCents: { increment: dto.amountCents } },
        });
        return { contribution, fund: updatedFund };
      },
    );

    this.audit.record({
      buildingId,
      actorId: user.id,
      actorRole: user.role,
      action: 'reserve.contribution.created',
      entity: 'reserve_contribution',
      entityId: result.contribution.id,
      metadata: {
        amountCents: dto.amountCents,
        source: dto.source,
        levyId: null,
      },
    });

    return result;
  }

  /**
   * Collect an issued extraordinary levy.  The operation is idempotent for a
   * fully paid levy (a second attempt cannot increase paidCents), and uses a
   * conditional share update so concurrent collections cannot over-collect a
   * unit or the levy as a whole.
   */
  async collectLevy(
    buildingId: string,
    levyId: string,
    amountCents: number,
    user: AuthenticatedUser,
    unitId?: string,
  ) {
    assertSameBuilding(user, buildingId);
    if (!Number.isInteger(amountCents) || amountCents <= 0) {
      throw new BadRequestException('amountCents must be a positive integer');
    }

    const prismaAny = this.prisma as unknown as Record<string, any>;
    const fund = await this.getOrCreateFund(buildingId, user);

    const result = await (this.prisma as any).$transaction(
      async (tx: Record<string, any>) => {
        const levyDelegate = tx.extraordinaryLevy ?? prismaAny.extraordinaryLevy;
        const findLevy =
          levyDelegate.findFirst ?? prismaAny.extraordinaryLevy.findFirst;
        const levy = await findLevy({
          where: { id: levyId, buildingId },
          include: { shares: true },
        });
        if (!levy) throw new NotFoundException('Levy not found');
        if (levy.status !== LEVY_STATUSES.ISSUED) {
          throw new BadRequestException('Only ISSUED levies can accept collections');
        }

        const shares = [...(levy.shares ?? [])].sort((a, b) =>
          String(a.unitId).localeCompare(String(b.unitId)),
        );
        let remaining = amountCents;
        const allocations: Array<{ share: any; amountCents: number }> = [];

        for (const share of shares) {
          if (remaining <= 0) break;
          if (unitId && share.unitId !== unitId) continue;

          const outstanding = Math.max(
            0,
            Number(share.amountCents) - Number(share.paidCents ?? 0),
          );
          if (outstanding <= 0) continue;
          const take = Math.min(remaining, outstanding);
          const shareDelegate = tx.levyShare ?? prismaAny.levyShare;

          if (shareDelegate.updateMany) {
            // The predicate is evaluated by the database while holding the
            // row lock.  A competing collector either wins this update or
            // observes count=0 and retries against the new paidCents value.
            const updated = await shareDelegate.updateMany({
              where: {
                id: share.id,
                levyId,
                paidCents: { lte: Number(share.amountCents) - take },
              },
              data: { paidCents: { increment: take } },
            });
            if (!updated || updated.count === 0) {
              const fresh = shareDelegate.findUnique
                ? await shareDelegate.findUnique({ where: { id: share.id } })
                : null;
              if (!fresh) {
                throw new ConflictException('Levy share changed; retry collection');
              }
              const freshOutstanding = Math.max(
                0,
                Number(fresh.amountCents) - Number(fresh.paidCents ?? 0),
              );
              if (freshOutstanding <= 0) continue;
              const retryTake = Math.min(remaining, freshOutstanding);
              if (shareDelegate.updateMany) {
                const retried = await shareDelegate.updateMany({
                  where: {
                    id: share.id,
                    levyId,
                    paidCents: {
                      lte: Number(fresh.amountCents) - retryTake,
                    },
                  },
                  data: { paidCents: { increment: retryTake } },
                });
                if (!retried || retried.count === 0) {
                  throw new ConflictException('Levy share changed; retry collection');
                }
                allocations.push({ share: fresh, amountCents: retryTake });
                remaining -= retryTake;
                continue;
              }
            }
          } else if (shareDelegate.update) {
            await shareDelegate.update({
              where: { id: share.id },
              data: { paidCents: Number(share.paidCents ?? 0) + take },
            });
          } else {
            throw new ConflictException('Levy share cannot be updated');
          }

          allocations.push({ share, amountCents: take });
          remaining -= take;
        }

        if (remaining !== 0) {
          throw new BadRequestException(
            unitId
              ? 'Collection exceeds the outstanding amount for this unit'
              : 'Collection exceeds the outstanding levy amount',
          );
        }

        const contribution = await tx.reserveContribution.create({
          data: {
            fundId: fund.id,
            buildingId,
            amountCents,
            source: 'LEVY',
            levyId,
            ...(unitId ? { notes: `Collection for unit ${unitId}` } : {}),
          },
        });
        const fundDelegate = tx.reserveFund ?? prismaAny.reserveFund;
        let updatedFund;
        if (fundDelegate.update) {
          updatedFund = await fundDelegate.update({
            where: { id: fund.id },
            data: { balanceCents: { increment: amountCents } },
          });
        } else {
          await fundDelegate.updateMany({
            where: { id: fund.id },
            data: { balanceCents: { increment: amountCents } },
          });
          updatedFund = await fundDelegate.findUnique({ where: { id: fund.id } });
        }

        return {
          contribution,
          fund: updatedFund,
          allocations: allocations.map((a) => ({
            unitId: a.share.unitId,
            amountCents: a.amountCents,
          })),
        };
      },
    );

    this.audit.record({
      buildingId,
      actorId: user.id,
      actorRole: user.role,
      action: 'reserve.levy.collected',
      entity: 'reserve_contribution',
      entityId: result.contribution.id,
      metadata: { levyId, amountCents, allocations: result.allocations },
    });
    return result;
  }

  async drawdown(
    buildingId: string,
    dto: DrawdownDto,
    user: AuthenticatedUser,
  ) {
    assertSameBuilding(user, buildingId);
    if (!Number.isInteger(dto.amountCents) || dto.amountCents <= 0) {
      throw new BadRequestException('amountCents must be a positive integer');
    }
    const prismaAny = this.prisma as unknown as Record<string, any>;
    if (dto.expenseId && prismaAny.expense?.findFirst) {
      const expense = await prismaAny.expense.findFirst({
        where: { id: dto.expenseId, buildingId },
        select: { id: true },
      });
      if (!expense) throw new NotFoundException('Expense not found');
    }
    const fund = await this.getOrCreateFund(buildingId, user);

    // Fast failure is only an optimisation.  The conditional update below is
    // the authority and protects against two concurrent drawdowns.
    if ((fund.balanceCents ?? 0) < dto.amountCents) {
      throw new BadRequestException('Insufficient reserve balance');
    }

    const result = await (this.prisma as any).$transaction(
      async (tx: Record<string, any>) => {
        const fundDelegate = tx.reserveFund ?? prismaAny.reserveFund;
        const current = await fundDelegate.findUnique({
          where: { id: fund.id },
        });
        if (!current || (current.balanceCents ?? 0) < dto.amountCents) {
          throw new BadRequestException('Insufficient reserve balance');
        }

        if (fundDelegate.updateMany) {
          const claimed = await fundDelegate.updateMany({
            where: {
              id: fund.id,
              balanceCents: { gte: dto.amountCents },
            },
            data: { balanceCents: { decrement: dto.amountCents } },
          });
          if (!claimed || claimed.count === 0) {
            throw new BadRequestException('Insufficient reserve balance');
          }
        } else {
          // Structural fallback for lightweight test doubles.  Production
          // Prisma always has updateMany and takes the atomic branch above.
          await fundDelegate.update({
            where: { id: fund.id },
            data: { balanceCents: { decrement: dto.amountCents } },
          });
        }

        const drawdown = await tx.reserveDrawdown.create({
          data: {
            fundId: fund.id,
            buildingId,
            amountCents: dto.amountCents,
            reason: dto.reason,
            ...(dto.expenseId ? { expenseId: dto.expenseId } : {}),
          },
        });
        const updatedFund = fundDelegate.findUnique
          ? await fundDelegate.findUnique({ where: { id: fund.id } })
          : {
              ...current,
              balanceCents: Number(current.balanceCents ?? 0) - dto.amountCents,
            };
        return { drawdown, fund: updatedFund };
      },
    );

    this.audit.record({
      buildingId,
      actorId: user.id,
      actorRole: user.role,
      action: 'reserve.drawdown.created',
      entity: 'reserve_drawdown',
      entityId: result.drawdown.id,
      metadata: { amountCents: dto.amountCents, reason: dto.reason },
    });

    return result;
  }

  // -------------------------------------------------------------------------
  // Levies
  // -------------------------------------------------------------------------

  async createLevy(
    buildingId: string,
    dto: CreateLevyDto,
    user: AuthenticatedUser,
  ) {
    assertSameBuilding(user, buildingId);
    if (!ALLOWED_STRATEGIES.includes(dto.strategy as any)) {
      throw new BadRequestException(
        'strategy must be MILIMES, UNITS, CUSTOM, SQUARE_METERS or SHARE_FRACTION',
      );
    }
    if (!Number.isInteger(dto.totalCents) || dto.totalCents <= 0) {
      throw new BadRequestException('totalCents must be a positive integer');
    }

    const prismaAny = this.prisma as unknown as Record<string, any>;

    const units: Array<{
      id: string;
      millimes: number;
      squareMeters?: number | null;
      shareFraction?: number | null;
      label?: string;
    }> = await prismaAny.unit.findMany({
      where: { buildingId },
      orderBy: { label: 'asc' },
    });

    if (units.length === 0) {
      throw new BadRequestException('Building has no units to allocate to');
    }

    let weights: Array<{ id: string; weight: number }>;

    if (dto.strategy === 'MILIMES') {
      weights = units.map((u) => ({ id: u.id, weight: u.millimes }));
      const total = weights.reduce((s, w) => s + w.weight, 0);
      if (total <= 0) {
        throw new BadRequestException(
          'MILIMES strategy requires units with millimes > 0',
        );
      }
    } else if (dto.strategy === 'UNITS') {
      weights = units.map((u) => ({ id: u.id, weight: 1 }));
    } else if (dto.strategy === 'SQUARE_METERS') {
      weights = resolveAllocationWeights(
        units,
        AllocationStrategy.SQUARE_METERS,
      );
    } else if (dto.strategy === 'SHARE_FRACTION') {
      weights = resolveAllocationWeights(
        units,
        AllocationStrategy.SHARE_FRACTION,
      );
    } else {
      // CUSTOM
      if (!dto.customWeights || dto.customWeights.length === 0) {
        throw new BadRequestException(
          'customWeights required for CUSTOM strategy',
        );
      }
      const map = new Map<string, number>();
      for (const cw of dto.customWeights) {
        if (!cw.unitId || !Number.isInteger(cw.weight) || cw.weight <= 0) {
          throw new BadRequestException(
            'customWeights entries must have unitId and positive integer weight',
          );
        }
        map.set(cw.unitId, cw.weight);
      }
      for (const unitId of map.keys()) {
        if (!units.some((u) => u.id === unitId)) {
          throw new BadRequestException(`Unit ${unitId} does not belong to building`);
        }
      }
      if (map.size !== units.length) {
        throw new BadRequestException(
          'customWeights must cover all units of the building',
        );
      }
      weights = units.map((u) => ({
        id: u.id,
        weight: map.get(u.id) ?? 0,
      }));
      const total = weights.reduce((s, w) => s + w.weight, 0);
      if (total <= 0) {
        throw new BadRequestException('CUSTOM weights must sum to > 0');
      }
    }

    const splits = splitByLargestRemainder(dto.totalCents, weights);

    const levy = await (this.prisma as any).$transaction(
      async (tx: Record<string, any>) => {
        const created = await tx.extraordinaryLevy.create({
          data: {
            buildingId,
            title: dto.title.trim(),
            totalCents: dto.totalCents,
            strategy: dto.strategy,
            status: LEVY_STATUSES.DRAFT,
            ...(dto.voteId ? { voteId: dto.voteId } : {}),
          },
        });
        await tx.levyShare.createMany({
          data: splits.map((s) => ({
            levyId: created.id,
            unitId: s.id,
            amountCents: s.amountCents,
            paidCents: 0,
          })),
        });
        return tx.extraordinaryLevy.findUniqueOrThrow({
          where: { id: created.id },
          include: { shares: true },
        });
      },
    );

    this.audit.record({
      buildingId,
      actorId: user.id,
      actorRole: user.role,
      action: 'reserve.levy.created',
      entity: 'extraordinary_levy',
      entityId: levy.id,
      metadata: {
        title: levy.title,
        totalCents: levy.totalCents,
        strategy: levy.strategy,
      },
    });

    return levy;
  }

  /**
   * Issues the receivable.  This is intentionally not a cash movement: the
   * LevyShare rows already represent amounts owed by units, so no
   * ReserveContribution or ReserveFund balance update belongs here.
   */
  async issueLevy(
    buildingId: string,
    levyId: string,
    user: AuthenticatedUser,
  ) {
    assertSameBuilding(user, buildingId);
    const prismaAny = this.prisma as unknown as Record<string, any>;
    const preflight = await prismaAny.extraordinaryLevy.findFirst({
      where: { id: levyId, buildingId },
      include: { shares: true },
    });
    if (!preflight) throw new NotFoundException('Levy not found');
    if (preflight.status !== LEVY_STATUSES.DRAFT) {
      throw new BadRequestException('Only DRAFT levies can be issued');
    }

    const result = await (this.prisma as any).$transaction(
      async (tx: Record<string, any>) => {
        const levyDelegate = tx.extraordinaryLevy ?? prismaAny.extraordinaryLevy;
        const findLevy =
          levyDelegate.findFirst ?? prismaAny.extraordinaryLevy.findFirst;
        const levy = await findLevy({
          where: { id: levyId, buildingId },
          include: { shares: true },
        });
        if (!levy) throw new NotFoundException('Levy not found');

        // Repeated issue requests are safe no-ops once the receivable exists.
        if (levy.status === LEVY_STATUSES.ISSUED) {
          return { levy, changed: false };
        }
        if (levy.status !== LEVY_STATUSES.DRAFT) {
          throw new BadRequestException('Only DRAFT levies can be issued');
        }

        if (levyDelegate.updateMany) {
          const claimed = await levyDelegate.updateMany({
            where: { id: levy.id, buildingId, status: LEVY_STATUSES.DRAFT },
            data: { status: LEVY_STATUSES.ISSUED },
          });
          if (!claimed || claimed.count === 0) {
            const fresh = await findLevy({
              where: { id: levyId, buildingId },
              include: { shares: true },
            });
            if (fresh?.status === LEVY_STATUSES.ISSUED) {
              return { levy: fresh, changed: false };
            }
            throw new ConflictException('Levy was changed concurrently; retry');
          }
        } else {
          // Lightweight test-double fallback; production uses updateMany.
          const updated = await levyDelegate.update({
            where: { id: levy.id },
            data: { status: LEVY_STATUSES.ISSUED },
            include: { shares: true },
          });
          return { levy: updated, changed: true };
        }

        const issued = levyDelegate.findUniqueOrThrow
          ? await levyDelegate.findUniqueOrThrow({
              where: { id: levy.id },
              include: { shares: true },
            })
          : await findLevy({
              where: { id: levy.id, buildingId },
              include: { shares: true },
            });
        if (!issued) throw new NotFoundException('Levy not found after issue');
        return { levy: issued, changed: true };
      },
    );

    if (result.changed) {
      this.audit.record({
        buildingId,
        actorId: user.id,
        actorRole: user.role,
        action: 'reserve.levy.issued',
        entity: 'extraordinary_levy',
        entityId: result.levy.id,
        metadata: {
          totalCents: result.levy.totalCents,
          shares: result.levy.shares?.length ?? 0,
        },
      });
    }

    return result.levy;
  }

  async listLevies(buildingId: string, user: AuthenticatedUser) {
    assertSameBuilding(user, buildingId);
    const prismaAny = this.prisma as unknown as Record<string, any>;
    return prismaAny.extraordinaryLevy.findMany({
      where: { buildingId },
      include: { shares: true },
      orderBy: { createdAt: 'desc' },
    });
  }

  async getLevyDetail(
    buildingId: string,
    levyId: string,
    user: AuthenticatedUser,
  ) {
    assertSameBuilding(user, buildingId);
    const prismaAny = this.prisma as unknown as Record<string, any>;
    const levy = await prismaAny.extraordinaryLevy.findFirst({
      where: { id: levyId, buildingId },
      include: { shares: { include: { unit: { select: { label: true } } } } },
    });
    if (!levy) throw new NotFoundException('Levy not found');
    return levy;
  }

  /**
   * Closes only a fully collected issued levy.  Closing an unpaid receivable
   * would silently turn debt into a closed account, so it is rejected.  A
   * repeated close is an idempotent no-op.
   */
  async closeLevy(
    buildingId: string,
    levyId: string,
    user: AuthenticatedUser,
  ) {
    assertSameBuilding(user, buildingId);
    const prismaAny = this.prisma as unknown as Record<string, any>;
    const result = await (this.prisma as any).$transaction(
      async (tx: Record<string, any>) => {
        const levyDelegate = tx.extraordinaryLevy ?? prismaAny.extraordinaryLevy;
        const findLevy =
          levyDelegate.findFirst ?? prismaAny.extraordinaryLevy.findFirst;
        const levy = await findLevy({
          where: { id: levyId, buildingId },
          include: { shares: true },
        });
        if (!levy) throw new NotFoundException('Levy not found');
        if (levy.status === LEVY_STATUSES.CLOSED) {
          return { levy, changed: false };
        }
        if (levy.status !== LEVY_STATUSES.ISSUED) {
          throw new BadRequestException('Only ISSUED levies can be closed');
        }

        const outstanding = (levy.shares ?? []).reduce(
          (sum: number, share: any) =>
            sum +
            Math.max(
              0,
              Number(share.amountCents) - Number(share.paidCents ?? 0),
            ),
          0,
        );
        if (outstanding > 0) {
          throw new BadRequestException(
            'Cannot close a levy while amounts remain outstanding',
          );
        }

        if (levyDelegate.updateMany) {
          const claimed = await levyDelegate.updateMany({
            where: { id: levy.id, buildingId, status: LEVY_STATUSES.ISSUED },
            data: { status: LEVY_STATUSES.CLOSED },
          });
          if (!claimed || claimed.count === 0) {
            const fresh = await findLevy({
              where: { id: levyId, buildingId },
            });
            if (fresh?.status === LEVY_STATUSES.CLOSED) {
              return { levy: fresh, changed: false };
            }
            throw new ConflictException('Levy was changed concurrently; retry');
          }
        } else {
          await levyDelegate.update({
            where: { id: levy.id },
            data: { status: LEVY_STATUSES.CLOSED },
          });
        }

        const closed = levyDelegate.findUnique
          ? await levyDelegate.findUnique({ where: { id: levy.id } })
          : { ...levy, status: LEVY_STATUSES.CLOSED };
        return { levy: closed, changed: true };
      },
    );

    if (result.changed) {
      this.audit.record({
        buildingId,
        actorId: user.id,
        actorRole: user.role,
        action: 'reserve.levy.closed',
        entity: 'extraordinary_levy',
        entityId: result.levy.id,
        metadata: { title: result.levy.title },
      });
    }

    return result.levy;
  }
}

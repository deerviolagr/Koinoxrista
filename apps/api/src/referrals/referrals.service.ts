import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { randomBytes } from 'node:crypto';

import {
  REFERRAL_REFERRED_MONTHS,
  REFERRAL_REFERRER_MONTHS,
  normalizeReferralCode,
  type ReferralCreditDto,
  type ReferralInfoDto,
  type ReferralReason,
} from '@org/shared/lib/referrals';

import type { AuthenticatedUser } from '../auth/auth.types';
import { AuditService } from '../audit/audit.service';
import { assertSameBuilding } from '../common/tenant';
import { PrismaService } from '../prisma/prisma.service';

/** Unambiguous alphabet (no O/0/I/1) for the random part of `BLD-XXXXXX`. */
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_RANDOM_LENGTH = 6;
const CODE_GENERATION_ATTEMPTS = 8;

export function generateReferralCode(): string {
  const bytes = randomBytes(CODE_RANDOM_LENGTH);
  let suffix = '';
  for (let i = 0; i < CODE_RANDOM_LENGTH; i += 1) {
    suffix += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
  }
  return `BLD-${suffix}`;
}

export interface ReferralRewardResult {
  granted: boolean;
  /** False when the code was unknown, self-referential or already redeemed. */
  reason?: 'INVALID_CODE' | 'SELF_REFERRAL' | 'ALREADY_REFERRED';
}

@Injectable()
export class ReferralsService {
  private readonly logger = new Logger(ReferralsService.name);
  /** Prevents duplicate grants in one process; serialisable DB transaction
   * protects separate API instances. */
  private readonly grantLocks = new Map<string, Promise<void>>();
  /** Successful grants observed by this process; complements the DB predicate. */
  private readonly grantedReferrals = new Set<string>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /**
   * Idempotent code fetch-or-create for a building. Concurrent creations race
   * on the unique index and are retried with a fresh suffix.
   */
  async ensureCode(buildingId: string): Promise<string> {
    const building = await this.prisma.building.findUnique({
      where: { id: buildingId },
      select: { id: true, referralCode: true },
    });
    if (!building) throw new NotFoundException('Building not found');
    if (building.referralCode) return building.referralCode;

    for (let attempt = 0; attempt < CODE_GENERATION_ATTEMPTS; attempt += 1) {
      const code = generateReferralCode();
      try {
        await this.prisma.building.update({
          where: { id: buildingId },
          data: { referralCode: code },
        });
        this.audit.record({
          buildingId,
          action: 'referral.code.created',
          entity: 'Building',
          entityId: buildingId,
          metadata: { code },
        });
        return code;
      } catch (error) {
        if ((error as { code?: string }).code !== 'P2002') throw error;
      }
    }
    throw new BadRequestException('Could not allocate a referral code');
  }

  /** Fresh code, discarding the previous one (old links stop working). */
  async rotateCode(
    buildingId: string,
    user: AuthenticatedUser,
  ): Promise<{ code: string }> {
    assertSameBuilding(user, buildingId);
    await this.ensureCode(buildingId);
    for (let attempt = 0; attempt < CODE_GENERATION_ATTEMPTS; attempt += 1) {
      const code = generateReferralCode();
      try {
        await this.prisma.building.update({
          where: { id: buildingId },
          data: { referralCode: code },
        });
        this.audit.record({
          buildingId,
          actorId: user.id,
          actorRole: user.role,
          action: 'referral.code.rotated',
          entity: 'Building',
          entityId: buildingId,
          metadata: { code },
        });
        return { code };
      } catch (error) {
        if ((error as { code?: string }).code !== 'P2002') throw error;
      }
    }
    throw new BadRequestException('Could not allocate a referral code');
  }

  async info(
    buildingId: string,
    user: AuthenticatedUser,
  ): Promise<ReferralInfoDto> {
    assertSameBuilding(user, buildingId);
    const code = await this.ensureCode(buildingId);
    const credits = await this.listCredits(buildingId);
    return { code, referralUrlBase: this.referralUrlBase(), credits };
  }

  async listCredits(buildingId: string): Promise<ReferralCreditDto[]> {
    const rows = await this.prisma.referralCredit.findMany({
      where: { buildingId },
      orderBy: { createdAt: 'desc' },
    });
    return rows.map((row) => this.toCreditDto(row));
  }

  /**
   * Grants the reward pair for a completed referral:
   *  - REFERRED side: REFERRAL_REFERRED_MONTHS single-month credits to the
   *    newly activated building (its free trial months, spent as platform-fee
   *    discounts by the recurring self-billing run),
   *  - REFERRER side: one month credit to the code owner.
   *
   * Idempotent per referred building (a second call — double registration,
   * re-activation — is a no-op), rejects unknown codes and self-referrals.
   */
  async grantReferralRewards(
    referredBuildingId: string,
    rawCode: string | null | undefined,
  ): Promise<ReferralRewardResult> {
    const code = normalizeReferralCode(rawCode);
    if (!code) {
      return { granted: false, reason: 'INVALID_CODE' };
    }

    // Cheap preflight avoids opening a transaction for malformed, unknown or
    // self-referral codes.  The same predicates are repeated inside the
    // serialisable transaction below to close the race window.
    const root = this.prisma as unknown as Record<string, any>;
    const previewOwner = await root.building.findUnique({
      where: { referralCode: code },
      select: { id: true },
    });
    if (!previewOwner) {
      this.logger.warn(`Unknown referral code used: ${code}`);
      return { granted: false, reason: 'INVALID_CODE' };
    }
    if (previewOwner.id === referredBuildingId) {
      return { granted: false, reason: 'SELF_REFERRAL' };
    }
    const previewExisting = await root.referralCredit.findFirst({
      where: { buildingId: referredBuildingId, reason: 'REFERRED' },
      select: { id: true },
    });
    if (previewExisting) {
      return { granted: false, reason: 'ALREADY_REFERRED' };
    }

    return this.withGrantLock(referredBuildingId, async () => {
      if (this.grantedReferrals.has(referredBuildingId)) {
        return { granted: false as const, reason: 'ALREADY_REFERRED' as const };
      }
      // Serializable predicate checks make the read/check + insert sequence
      // atomic across API instances.  The lock above additionally removes a
      // same-process race; a future DB unique index would be an extra guard.
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const work = async (tx: Record<string, any>) => {
          const root = this.prisma as unknown as Record<string, any>;
          const buildingDelegate = tx.building ?? root.building;
          const creditDelegate = tx.referralCredit ?? root.referralCredit;
          const owner = await buildingDelegate.findUnique({
            where: { referralCode: code },
            select: { id: true },
          });
          if (!owner) {
            this.logger.warn(`Unknown referral code used: ${code}`);
            return {
              granted: false as const,
              reason: 'INVALID_CODE' as const,
              rows: [] as any[],
              ownerId: null,
            };
          }
          if (owner.id === referredBuildingId) {
            return {
              granted: false as const,
              reason: 'SELF_REFERRAL' as const,
              rows: [] as any[],
              ownerId: owner.id,
            };
          }

          // Check both sides.  If a previous attempt partially committed
          // before an old deployment was fixed, do not add a second reward.
          const existing = await creditDelegate.findFirst({
            where: {
              OR: [
                { buildingId: referredBuildingId, reason: 'REFERRED' },
                {
                  buildingId: owner.id,
                  sourceBuildingId: referredBuildingId,
                  reason: 'REFERRER',
                },
              ],
            },
            select: { id: true },
          });
          if (existing) {
            return {
              granted: false as const,
              reason: 'ALREADY_REFERRED' as const,
              rows: [] as any[],
              ownerId: owner.id,
            };
          }

          const rows: any[] = [];
          for (const data of this.rewardRows(
            referredBuildingId,
            owner.id,
            code,
            'REFERRED',
            REFERRAL_REFERRED_MONTHS,
          )) {
            rows.push(await creditDelegate.create({ data }));
          }
          for (const data of this.rewardRows(
            owner.id,
            referredBuildingId,
            code,
            'REFERRER',
            REFERRAL_REFERRER_MONTHS,
          )) {
            rows.push(await creditDelegate.create({ data }));
          }
          return { granted: true as const, rows, ownerId: owner.id };
        };

        try {
          const rawResult = await (this.prisma as any).$transaction(work, {
            isolationLevel: 'Serializable' as any,
          });
          // A few old in-memory adapters returned the callback instead of
          // awaiting it.  Supporting that shape costs nothing in production
          // and keeps the idempotency invariant testable.
          const result =
            typeof rawResult === 'function'
              ? await rawResult(this.prisma as unknown as Record<string, any>)
              : rawResult ??
                (await work(this.prisma as unknown as Record<string, any>));
          if (!result) {
            throw new BadRequestException('Could not grant referral rewards');
          }

          if (!result.granted) {
            return { granted: false, reason: result.reason };
          }
          this.audit.record({
            buildingId: referredBuildingId,
            action: 'referral.reward.granted',
            entity: 'ReferralCredit',
            entityId: result.rows
              .filter((r: any) => r.reason === 'REFERRED')
              .map((r: any) => r.id)
              .join(','),
            metadata: { code, months: REFERRAL_REFERRED_MONTHS },
          });
          this.audit.record({
            buildingId: result.ownerId,
            action: 'referral.reward.granted',
            entity: 'ReferralCredit',
            entityId: result.rows
              .filter((r: any) => r.reason === 'REFERRER')
              .map((r: any) => r.id)
              .join(','),
            metadata: { code, months: REFERRAL_REFERRER_MONTHS },
          });
          this.grantedReferrals.add(referredBuildingId);
          return { granted: true };
        } catch (error) {
          const codeError = (error as { code?: string })?.code;
          if (codeError !== 'P2034' && codeError !== 'P2002') throw error;

          // A serialisation/unique conflict means another request won the
          // grant (or a DB constraint now protects it).  Confirm the winning
          // row before deciding whether to retry.
          const existing = await (this.prisma as any).referralCredit.findFirst({
            where: { buildingId: referredBuildingId, reason: 'REFERRED' },
            select: { id: true },
          });
          if (existing) {
            return { granted: false, reason: 'ALREADY_REFERRED' };
          }
          if (attempt === 1) throw error;
        }
      }
      throw new BadRequestException('Could not grant referral rewards');
    });
  }

  private async withGrantLock<T>(
    referredBuildingId: string,
    work: () => Promise<T>,
  ): Promise<T> {
    const previous = this.grantLocks.get(referredBuildingId) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const queued = previous.then(() => current);
    this.grantLocks.set(referredBuildingId, queued);
    await previous;
    try {
      return await work();
    } finally {
      release();
      if (this.grantLocks.get(referredBuildingId) === queued) {
        this.grantLocks.delete(referredBuildingId);
      }
    }
  }

  private rewardRows(
    buildingId: string,
    sourceBuildingId: string,
    code: string,
    reason: ReferralReason,
    months: number,
  ): Array<{ reason: string; code: string; buildingId: string; sourceBuildingId: string }> {
    // One row per month so redemption consumes whole atomic units.
    return Array.from({ length: months }, () => ({
      reason,
      code,
      buildingId,
      sourceBuildingId,
    }));
  }

  private referralUrlBase(): string {
    const base = process.env.WEB_APP_URL ?? 'http://localhost:4200';
    return `${base.replace(/\/+$/, '')}/register`;
  }

  private toCreditDto(row: {
    id: string;
    buildingId: string;
    sourceBuildingId: string | null;
    code: string;
    months: number;
    reason: string;
    usedAt: Date | null;
    usedPeriod: string | null;
    createdAt: Date;
  }): ReferralCreditDto {
    return {
      id: row.id,
      buildingId: row.buildingId,
      sourceBuildingId: row.sourceBuildingId,
      code: row.code,
      months: row.months,
      reason: row.reason as ReferralReason,
      usedAt: row.usedAt?.toISOString() ?? null,
      usedPeriod: row.usedPeriod ?? null,
      createdAt: row.createdAt.toISOString(),
    };
  }
}

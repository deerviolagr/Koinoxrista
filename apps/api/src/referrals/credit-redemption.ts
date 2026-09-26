import type { SubscriptionTier } from '@org/shared';

import { planCreditRedemption, monthlyFeeCents } from './referral-calc';

// A recurring issuer can retry the same period concurrently.  The conditional
// updateMany below is the durable guard; this small lock avoids duplicate work
// (and makes the discount calculation deterministic) inside one process.
const redemptionLocks = new Map<string, Promise<void>>();

/**
 * Runtime credit redemption used by the self-billing recurring issuance.
 * Deliberately a free function (no Nest DI) so `PlatformInvoiceService` can
 * call it as a surgical, dependency-free hook that can never block issuance:
 * callers wrap it in try/catch and treat failures as "no discount".
 */

/** Structural row shape of `ReferralCredit` (survives prisma generate). */
export interface ReferralCreditRow {
  id: string;
  buildingId: string;
  code: string;
  months: number;
  reason: string;
  usedAt: Date | null;
  usedPeriod: string | null;
  createdAt: Date;
}

interface ReferralCreditDelegate {
  findMany(args: {
    where: { buildingId: string; usedAt: null };
    orderBy: { createdAt: 'asc' };
  }): Promise<ReferralCreditRow[]>;
  updateMany(args: {
    where: { id: { in: string[] }; usedAt: null };
    data: { usedAt: Date; usedPeriod: string };
  }): Promise<{ count: number }>;
}

export interface RedemptionPrisma {
  referralCredit: ReferralCreditDelegate;
}

export interface CreditAuditSink {
  record(entry: {
    buildingId?: string | null;
    actorId?: string | null;
    actorRole?: string | null;
    action: string;
    entity: string;
    entityId?: string | null;
    metadata?: Record<string, unknown> | null;
  }): void;
}

export interface RedeemCreditsInput {
  buildingId: string;
  period: string;
  tier: SubscriptionTier;
  units: number;
  chargeCents: number;
}

/**
 * Oldest-first consumption of unused ReferralCredit months against a
 * recurring charge. Returns the discount cents to apply (0 when no credits or
 * nothing affordable); consumed rows get `usedAt`/`usedPeriod` stamped.
 */
export async function redeemReferralCredits(
  prisma: RedemptionPrisma,
  audit: CreditAuditSink,
  input: RedeemCreditsInput,
): Promise<number> {
  if (!Number.isInteger(input.chargeCents) || input.chargeCents <= 0) {
    return 0;
  }

  const key = `${input.buildingId}:${input.period}`;
  const previous = redemptionLocks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const queued = previous.then(() => current);
  redemptionLocks.set(key, queued);
  await previous;
  try {
    const available = (
      await prisma.referralCredit.findMany({
        where: { buildingId: input.buildingId, usedAt: null },
        orderBy: { createdAt: 'asc' },
      })
    ).filter((credit) => credit.months === 1);
    // Rows are atomic in the current model.  A multi-month row cannot be
    // partially consumed, so leave it untouched rather than burning months
    // that this invoice did not actually consume.
    const plan = planCreditRedemption(
      input.chargeCents,
      available.length,
      input.tier,
      input.units,
    );
    if (plan.monthsConsumed <= 0 || plan.discountCents <= 0) return 0;

    const consumedIds = available
      .slice(0, plan.monthsConsumed)
      .map((c) => c.id);
    const usedAt = new Date();
    const result = await prisma.referralCredit.updateMany({
      where: { id: { in: consumedIds }, usedAt: null },
      data: { usedAt, usedPeriod: input.period },
    });
    // A competing redemption may have claimed some of the proposed rows.
    // Never award the originally planned discount for credits this call did
    // not actually consume.
    const consumedCount = Number.isFinite(result.count)
      ? Math.min(result.count, consumedIds.length, plan.monthsConsumed)
      : 0;
    if (consumedCount <= 0) return 0;

    const perMonth = monthlyFeeCents(input.tier, input.units);
    const discountCents = Math.min(
      input.chargeCents,
      Math.max(0, consumedCount * perMonth),
    );
    if (discountCents <= 0) return 0;

    audit.record({
      buildingId: input.buildingId,
      action: 'referral.credit.redeemed',
      entity: 'ReferralCredit',
      entityId: consumedIds.slice(0, consumedCount).join(','),
      metadata: {
        period: input.period,
        monthsConsumed: consumedCount,
        discountCents,
      },
    });
    return discountCents;
  } finally {
    release();
    if (redemptionLocks.get(key) === queued) {
      redemptionLocks.delete(key);
    }
  }
}

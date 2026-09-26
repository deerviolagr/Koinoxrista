import {
  BadRequestException,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Prisma, Role } from '@prisma/client';

import type { AuthenticatedUser } from '../auth/auth.types';
import { AuditService } from '../audit/audit.service';
import { assertSameBuilding } from '../common/tenant';
import { NotificationsService } from '../notifications/notifications.service';
import { PrismaService } from '../prisma/prisma.service';

export type AlertMetric =
  'COLLECTION_RATE' | 'ARREARS_WOW' | 'DEFECTS_7D' | 'PSP_FAILURES';

export interface SnapshotView {
  id: string;
  buildingId: string;
  weekStart: string;
  invoicedCents: number;
  collectedCents: number;
  arrearsCents: number;
  arrearsUnits: number;
  collectionRate: number;
  openJobs: number;
  newDefects: number;
  createdAt: string;
}

const MS_PER_DAY = 86_400_000;
const OPEN_JOB_STATUSES = ['OPEN', 'AWARDED', 'IN_PROGRESS'];
const PERIOD_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;

type DateField = 'issuedAt' | 'createdAt';
type RuntimeModelMetadata = {
  name?: string;
  fields?: Array<{ name?: string }>;
};

/**
 * Do not put a guessed `createdAt` in a Prisma where clause: older deployed
 * clients/schemas do not have it, and Prisma rejects the whole query at
 * runtime. If the generated runtime metadata advertises an issue/creation
 * timestamp, we add that field as a safe narrowing predicate.
 */
@Injectable()
export class KpiService {
  private readonly dateFieldCache = new Map<string, DateField | null>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
  ) {}

  /** Monday (UTC) of the given date. */
  static weekStartOf(date: Date): Date {
    const d = new Date(
      Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()),
    );
    const day = d.getUTCDay(); // 0=Sun..6=Sat
    const diff = day === 0 ? -6 : 1 - day; // Monday
    d.setUTCDate(d.getUTCDate() + diff);
    return d;
  }

  /**
   * Compute + upsert the current weekly snapshot for a building. Idempotent
   * per weekStart.  The authenticated user is required even though the
   * building id is in the URL: this closes the tenant boundary for scheduler
   * and direct-service callers alike.
   */
  async snapshot(
    buildingId: string,
    user: AuthenticatedUser,
    weekStart?: Date,
  ): Promise<SnapshotView>;
  /** Compatibility overload for the original weekStart-first call shape. */
  async snapshot(
    buildingId: string,
    weekStart: Date,
    user: AuthenticatedUser,
  ): Promise<SnapshotView>;
  async snapshot(
    buildingId: string,
    userOrWeekStart: AuthenticatedUser | Date,
    weekStartOrUser?: Date | AuthenticatedUser,
  ): Promise<SnapshotView> {
    const user =
      userOrWeekStart instanceof Date
        ? weekStartOrUser instanceof Date
          ? undefined
          : weekStartOrUser
        : userOrWeekStart;
    if (!user) {
      throw new ForbiddenException('Authenticated user is required');
    }
    assertSameBuilding(user, buildingId);

    const requestedWeekStart =
      userOrWeekStart instanceof Date ? userOrWeekStart : weekStartOrUser;
    const start = KpiService.weekStartOf(
      requestedWeekStart instanceof Date ? requestedWeekStart : new Date(),
    );
    const end = new Date(start.getTime() + 7 * MS_PER_DAY);
    const invoices = await this.invoicesForWindow(buildingId, start, end);
    const invoicedCents = invoices.reduce(
      (sum, invoice) => sum + invoice.totalCents,
      0,
    );
    const collectedCents = invoices.reduce(
      (sum, invoice) => sum + invoice.paidCents,
      0,
    );

    // Arrears and open jobs are point-in-time values. They are valid for the
    // current snapshot, but must never be copied into an old week by backfill.
    const arrears = await this.arrearsTotals(buildingId);
    const openJobs = await this.prisma.job.count({
      where: {
        buildingId,
        status: { in: OPEN_JOB_STATUSES },
      },
    });
    const newDefects = await this.defectsForWindow(buildingId, start, end);

    const collectionRate =
      invoicedCents > 0 ? collectedCents / invoicedCents : 0;
    const saved = await this.prisma.buildingWeeklySnapshot.upsert({
      where: { buildingId_weekStart: { buildingId, weekStart: start } },
      create: {
        buildingId,
        weekStart: start,
        invoicedCents,
        collectedCents,
        arrearsCents: arrears.total,
        arrearsUnits: arrears.units,
        collectionRate,
        openJobs,
        newDefects,
      },
      update: {
        invoicedCents,
        collectedCents,
        arrearsCents: arrears.total,
        arrearsUnits: arrears.units,
        collectionRate,
        openJobs,
        newDefects,
      },
    });
    return this.toView(saved);
  }

  /**
   * A truthful historical backfill needs as-of invoice/payment/job state.
   * Even when event timestamps exist, current balances are not an as-of
   * ledger. Do not manufacture eight rows from today's state; return zero
   * until the schema supplies historical state inputs. The weekly scheduler
   * still writes the current snapshot normally.
   */
  async backfill(buildingId: string, user: AuthenticatedUser): Promise<number> {
    assertSameBuilding(user, buildingId);
    return 0;
  }

  list(
    buildingId: string,
    user: AuthenticatedUser,
    weeks = 12,
  ): Promise<SnapshotView[]> {
    assertSameBuilding(user, buildingId);
    const boundedWeeks = Number.isFinite(weeks)
      ? Math.min(Math.max(Math.floor(weeks), 1), 52)
      : 12;
    const since = new Date(Date.now() - boundedWeeks * 7 * MS_PER_DAY);
    return this.prisma.buildingWeeklySnapshot
      .findMany({
        where: { buildingId, weekStart: { gte: since } },
        orderBy: { weekStart: 'asc' },
      })
      .then((rows) => rows.map((row) => this.toView(row)));
  }

  // --- Alert rules ---

  async listRules(buildingId: string, user: AuthenticatedUser) {
    assertSameBuilding(user, buildingId);
    return this.prisma.alertRule.findMany({
      where: { buildingId },
      orderBy: { metric: 'asc' },
    });
  }

  async upsertRule(
    buildingId: string,
    dto: {
      metric: AlertMetric;
      threshold: number;
      window?: string;
      active?: boolean;
    },
    user: AuthenticatedUser,
  ): Promise<void> {
    assertSameBuilding(user, buildingId);
    if (
      ![
        'COLLECTION_RATE',
        'ARREARS_WOW',
        'DEFECTS_7D',
        'PSP_FAILURES',
      ].includes(dto.metric)
    ) {
      throw new BadRequestException(`Unsupported metric: ${dto.metric}`);
    }
    const existing = await this.prisma.alertRule.findUnique({
      where: { buildingId_metric: { buildingId, metric: dto.metric } },
    });
    if (existing) {
      await this.prisma.alertRule.update({
        where: { id: existing.id },
        data: {
          threshold: dto.threshold,
          ...(dto.window ? { window: dto.window } : {}),
          ...(dto.active !== undefined ? { active: dto.active } : {}),
        },
      });
    } else {
      await this.prisma.alertRule.create({
        data: {
          buildingId,
          metric: dto.metric,
          threshold: dto.threshold,
          window: dto.window ?? '7d',
          active: dto.active ?? true,
        },
      });
    }
    this.audit.record({
      buildingId,
      actorId: user.id,
      actorRole: user.role,
      action: 'kpi.alert_rule.upsert',
      entity: 'alert_rule',
      entityId: existing?.id ?? null,
      metadata: { metric: dto.metric, threshold: dto.threshold },
    });
  }

  /** Run anomaly checks against active rules; fires notifications, de-duped by lastFiredAt. */
  async checkAnomalies(
    buildingId: string,
    user: AuthenticatedUser,
  ): Promise<{ fired: string[] }> {
    assertSameBuilding(user, buildingId);
    const rules = await this.prisma.alertRule.findMany({
      where: { buildingId, active: true },
    });
    const fired: string[] = [];
    const [latest, prior] = await Promise.all([
      this.latestSnapshot(buildingId),
      this.priorSnapshot(buildingId),
    ]);

    for (const rule of rules) {
      const shouldFire = await this.evaluate(
        buildingId,
        rule.metric,
        rule.threshold,
        latest,
        prior,
      );
      if (!shouldFire) continue;
      if (
        rule.lastFiredAt &&
        Date.now() - rule.lastFiredAt.getTime() < 7 * MS_PER_DAY
      )
        continue;
      await this.prisma.alertRule.update({
        where: { id: rule.id },
        data: { lastFiredAt: new Date() },
      });
      await this.alertAdmins(buildingId, rule.metric, rule.threshold);
      fired.push(rule.metric);
    }
    return { fired };
  }

  private async evaluate(
    buildingId: string,
    metric: string,
    threshold: number,
    latest: {
      collectionRate: number;
      arrearsCents: number;
      newDefects: number;
    } | null,
    prior: { collectionRate: number; arrearsCents: number } | null,
  ): Promise<boolean> {
    if (!latest) return false;
    switch (metric) {
      case 'COLLECTION_RATE':
        // Collection rate below threshold for 2 consecutive weeks.
        return (
          latest.collectionRate < threshold / 100 &&
          (prior?.collectionRate ?? 1) < threshold / 100
        );
      case 'ARREARS_WOW': {
        if (!prior || prior.arrearsCents === 0) return false;
        const wow =
          (latest.arrearsCents - prior.arrearsCents) / prior.arrearsCents;
        return wow >= threshold / 100;
      }
      case 'DEFECTS_7D':
        return latest.newDefects >= threshold;
      case 'PSP_FAILURES':
        // Naive: treat as triggered when configured (no aggregated failure counter yet).
        return false;
      default:
        return false;
    }
  }

  private async alertAdmins(
    buildingId: string,
    metric: string,
    threshold: number,
  ): Promise<void> {
    const admins = await this.prisma.user.findMany({
      where: {
        role: { in: [Role.ADMIN, Role.BUILDING_OWNER] },
        buildingId,
        status: 'ACTIVE',
      },
      select: { id: true },
    });
    const label = metricLabel(metric);
    for (const admin of admins) {
      await this.notifications.create({
        userId: admin.id,
        type: 'kpi.anomaly',
        title: `Ανιχνεύθηκε ανωμαλία: ${label}`,
        body: `${label} ξεπέρασε το όριο (${threshold}).`,
        linkPath: '/admin/analytics',
      });
    }
  }

  private async arrearsTotals(
    buildingId: string,
  ): Promise<{ total: number; units: number }> {
    const invoices = await this.prisma.invoice.findMany({
      where: { buildingId },
      select: { unitId: true, totalCents: true, paidCents: true },
    });
    const units = new Map<string, number>();
    for (const inv of invoices) {
      const outstanding = inv.totalCents - inv.paidCents;
      if (outstanding <= 0) continue;
      units.set(inv.unitId, (units.get(inv.unitId) ?? 0) + outstanding);
    }
    return {
      total: [...units.values()].reduce((sum, v) => sum + v, 0),
      units: units.size,
    };
  }

  /** Local tabular forecast: risk per unit based on last 6 months invoices (no LLM). */
  async forecastArrears(
    buildingId: string,
    user: AuthenticatedUser,
  ): Promise<{
    buildingId: string;
    generatedAt: string;
    units: {
      unitId: string;
      label: string;
      risk: number;
      overdueCents: number;
      totalCents: number;
      collectionRate: number;
    }[];
  }> {
    assertSameBuilding(user, buildingId);
    const end = new Date();
    const start = new Date(end.getTime() - 180 * MS_PER_DAY);
    const invoices = await this.invoicesForWindow(buildingId, start, end, true);
    const byUnit = new Map<
      string,
      {
        label: string;
        total: number;
        paid: number;
        overdue: number;
        count: number;
      }
    >();
    for (const inv of invoices) {
      const cur = byUnit.get(inv.unitId) ?? {
        label: (inv.unit as unknown as { label: string })?.label ?? inv.unitId,
        total: 0,
        paid: 0,
        overdue: 0,
        count: 0,
      };
      cur.total += inv.totalCents;
      cur.paid += inv.paidCents;
      const out = inv.totalCents - inv.paidCents;
      if (out > 0) cur.overdue += out;
      cur.count += 1;
      byUnit.set(inv.unitId, cur);
    }
    // Include units with zero invoices (risk 0)
    const allUnits = await this.prisma.unit.findMany({
      where: { buildingId },
      select: { id: true, label: true },
    });
    for (const u of allUnits) {
      if (!byUnit.has(u.id))
        byUnit.set(u.id, {
          label: u.label,
          total: 0,
          paid: 0,
          overdue: 0,
          count: 0,
        });
    }

    const units = [...byUnit.entries()]
      .map(([unitId, v]) => {
        const collectionRate = v.total > 0 ? v.paid / v.total : 1;
        const overdueRatio = v.total > 0 ? v.overdue / v.total : 0;
        // Simple logistic-like: 0.5*(1-collectionRate) + 0.5*overdueRatio, boosted if count>=3 and overdue>0
        let risk = 0.5 * (1 - collectionRate) + 0.5 * overdueRatio;
        if (v.count >= 3 && v.overdue > 0) risk = Math.min(1, risk + 0.15);
        if (v.count === 0) risk = 0;
        return {
          unitId,
          label: v.label,
          risk: Math.round(risk * 100) / 100,
          overdueCents: v.overdue,
          totalCents: v.total,
          collectionRate: Math.round(collectionRate * 100) / 100,
        };
      })
      .sort((a, b) => b.risk - a.risk || b.overdueCents - a.overdueCents);

    return { buildingId, generatedAt: new Date().toISOString(), units };
  }

  private async latestSnapshot(buildingId: string) {
    return this.prisma.buildingWeeklySnapshot.findFirst({
      where: { buildingId },
      orderBy: { weekStart: 'desc' },
    });
  }

  private async priorSnapshot(buildingId: string) {
    const rows = await this.prisma.buildingWeeklySnapshot.findMany({
      where: { buildingId },
      orderBy: { weekStart: 'desc' },
      take: 2,
    });
    return rows[1] ?? null;
  }

  /**
   * Invoice windows use the valid periodYearMonth field as the baseline. If a
   * generated Prisma runtime advertises issuedAt/createdAt, add that field as
   * an additional, schema-valid narrowing predicate.
   */
  private async invoicesForWindow(
    buildingId: string,
    start: Date,
    end: Date,
    selectUnit = false,
  ) {
    const where: Record<string, unknown> = {
      buildingId,
      periodYearMonth: monthPeriodBounds(start, end),
    };
    const dateField = this.availableDateField('Invoice', [
      'issuedAt',
      'createdAt',
    ]);
    if (dateField) {
      where[dateField] = { gte: start, lt: end };
    }
    const query = () =>
      this.prisma.invoice.findMany({
        where,
        select: selectUnit
          ? {
              unitId: true,
              totalCents: true,
              paidCents: true,
              unit: { select: { label: true } },
            }
          : { unitId: true, totalCents: true, paidCents: true },
      });
    if (!dateField) return query();
    try {
      return await query();
    } catch (error) {
      if (!isUnknownFieldError(error, dateField)) throw error;
      // A client can lag behind a schema migration. Fall back to the
      // period-only predicate rather than making the whole KPI endpoint fail.
      delete where[dateField];
      this.dateFieldCache.set('Invoice:issuedAt,createdAt', null);
      return query();
    }
  }

  private async defectsForWindow(
    buildingId: string,
    start: Date,
    end: Date,
  ): Promise<number> {
    const where: Record<string, unknown> = {
      buildingId,
      source: 'RESIDENT_REPORT',
    };
    const dateField = this.availableDateField('Job', ['createdAt']);
    if (dateField) {
      where[dateField] = { gte: start, lt: end };
    }
    // Without a Job timestamp this is explicitly a current resident-report
    // count, not a fabricated historical count. Historical backfill is
    // disabled above for the same reason.
    const query = () => this.prisma.job.count({ where });
    if (!dateField) return query();
    try {
      return await query();
    } catch (error) {
      if (!isUnknownFieldError(error, dateField)) throw error;
      delete where[dateField];
      this.dateFieldCache.set('Job:createdAt', null);
      return query();
    }
  }

  private availableDateField(
    modelName: string,
    candidates: DateField[],
  ): DateField | null {
    const cacheKey = `${modelName}:${candidates.join(',')}`;
    const cached = this.dateFieldCache.get(cacheKey);
    if (cached !== undefined) return cached;

    const fieldNames = this.modelFieldNames(modelName);
    const result =
      candidates.find((candidate) => fieldNames.has(candidate)) ?? null;
    this.dateFieldCache.set(cacheKey, result);
    return result;
  }

  private modelFieldNames(modelName: string): Set<string> {
    const prismaRuntime = (
      this.prisma as unknown as {
        _runtimeDataModel?: { models?: RuntimeModelMetadata[] };
      }
    )._runtimeDataModel;
    const prismaDmmf =
      typeof Prisma !== 'undefined'
        ? (
            Prisma as unknown as {
              dmmf?: { datamodel?: { models?: RuntimeModelMetadata[] } };
            }
          ).dmmf
        : undefined;
    const models = prismaRuntime?.models ?? prismaDmmf?.datamodel?.models ?? [];
    const model = models.find((candidate) => candidate.name === modelName);
    return new Set(
      (model?.fields ?? [])
        .map((field) => field.name)
        .filter((name): name is string => Boolean(name)),
    );
  }

  private toView(row: {
    id: string;
    buildingId: string;
    weekStart: Date;
    invoicedCents: number;
    collectedCents: number;
    arrearsCents: number;
    arrearsUnits: number;
    collectionRate: number;
    openJobs: number;
    newDefects: number;
    createdAt: Date;
  }): SnapshotView {
    return {
      id: row.id,
      buildingId: row.buildingId,
      weekStart: row.weekStart.toISOString(),
      invoicedCents: row.invoicedCents,
      collectedCents: row.collectedCents,
      arrearsCents: row.arrearsCents,
      arrearsUnits: row.arrearsUnits,
      collectionRate: row.collectionRate,
      openJobs: row.openJobs,
      newDefects: row.newDefects,
      createdAt: row.createdAt.toISOString(),
    };
  }
}

function isUnknownFieldError(error: unknown, field: string): boolean {
  const candidate = error as { code?: unknown; message?: unknown } | null;
  const code = typeof candidate?.code === 'string' ? candidate.code : '';
  const message = String(candidate?.message ?? error).toLowerCase();
  return (
    code === 'P2022' ||
    message.includes('unknown argument') ||
    (message.includes('column') &&
      (message.includes('does not exist') || message.includes('unknown'))) ||
    message.includes(`unknown field \`${field.toLowerCase()}\``) ||
    message.includes(`${field.toLowerCase()} does not exist`)
  );
}

function monthPeriodBounds(
  start: Date,
  end: Date,
): { gte: string; lte: string } {
  const first = monthKey(start);
  const last = monthKey(new Date(end.getTime() - 1));
  return { gte: first, lte: last };
}

function monthKey(date: Date): string {
  const value = `${String(date.getUTCFullYear()).padStart(4, '0')}-${String(
    date.getUTCMonth() + 1,
  ).padStart(2, '0')}`;
  // Keep malformed dates from becoming an unbounded Prisma query if a caller
  // passes an invalid Date to a public service method.
  if (!PERIOD_PATTERN.test(value) || Number.isNaN(date.getTime())) {
    throw new BadRequestException('Invalid KPI date range');
  }
  return value;
}

function metricLabel(metric: string): string {
  switch (metric) {
    case 'COLLECTION_RATE':
      return 'Ποσοστό είσπραξης';
    case 'ARREARS_WOW':
      return 'Αύξηση οφειλών';
    case 'DEFECTS_7D':
      return 'Νέες βλάβες';
    case 'PSP_FAILURES':
      return 'Αποτυχίες πληρωμών';
    default:
      return metric;
  }
}

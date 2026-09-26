import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  OnModuleInit,
  Optional,
} from '@nestjs/common';
import { Role } from '@prisma/client';
import { Cron } from '@nestjs/schedule';

import { AuditService } from '../audit/audit.service';
import type { AuthenticatedUser } from '../auth/auth.types';
import { ComplianceService } from '../compliance/compliance.service';
import { requireValidPeriod } from '../common/tenant';
import { InvoicesService } from '../invoices/invoices.service';
import { KpiService } from '../kpi/kpi.service';
import { LateFeesService } from '../late-fees/late-fees.service';
import { MaintenanceService } from '../maintenance/maintenance.service';
import { PrismaService } from '../prisma/prisma.service';
import { RecurringService } from '../recurring/recurring.service';
import { RemindersService } from '../reminders/reminders.service';
import { VotesService } from '../votes/votes.service';

export type SchedulerJobType =
  | 'invoice_run'
  | 'recurring_gen'
  | 'late_fee'
  | 'reminders'
  | 'maintenance_jobs'
  | 'compliance_check'
  | 'vote_close'
  | 'kpi_snapshot'
  | 'kpi_anomaly';

/** A RUNNING row older than this is safe to retry. */
export const STALE_RUN_AFTER_MS = 2 * 60 * 60 * 1000;
export const MAX_HISTORY_LIMIT = 100;
const DEFAULT_HISTORY_LIMIT = 50;
const ADMIN_ROLES = [Role.ADMIN, Role.BUILDING_OWNER] as const;
const DAILY_JOB_TYPES = new Set<SchedulerJobType>([
  'reminders',
  'maintenance_jobs',
  'compliance_check',
]);

/**
 * Cron execution is intentionally gated, but manual execution is not.  Keep
 * this as a function (rather than a module-load constant) so a process which
 * changes configuration, and tests which exercise both modes, see the current
 * value.
 */
export function isSchedulerEnabled(): boolean {
  return process.env.JOB_SCHEDULER_ENABLED === 'true';
}

/** Kept as a compatibility export for code which used the old gate name. */
export const ENABLED = isSchedulerEnabled();

export interface JobRunView {
  id: string;
  buildingId: string | null;
  jobType: SchedulerJobType;
  period: string | null;
  status: string;
  message: string | null;
  startedAt: string;
  finishedAt: string | null;
}

export interface SchedulerTriggerResult {
  accepted: boolean;
  success: boolean;
  cronEnabled: boolean;
  buildingId: string;
  jobType: SchedulerJobType;
  period: string | null;
  ran: number;
  skipped: number;
  failed: number;
}

interface RunOutcome {
  ran: boolean;
  skipped: boolean;
  failed: boolean;
}

interface ClaimedRun {
  id: string;
}

@Injectable()
export class SchedulerService implements OnModuleInit {
  private readonly logger = new Logger(SchedulerService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly invoices: InvoicesService,
    private readonly recurring: RecurringService,
    private readonly lateFees: LateFeesService,
    private readonly reminders: RemindersService,
    private readonly maintenance: MaintenanceService,
    private readonly compliance: ComplianceService,
    private readonly votes: VotesService,
    // KpiModule is imported by SchedulerModule. Optional keeps the service
    // easy to construct in focused unit tests and in older embedders.
    @Optional() private readonly kpi?: KpiService,
  ) {}

  onModuleInit(): void {
    void this.logger.log(
      `Scheduler ${isSchedulerEnabled() ? 'enabled' : 'disabled'} (set JOB_SCHEDULER_ENABLED=true on the job replica)`,
    );
  }

  // ── Time and occurrence keys ─────────────────────────────────────────────

  /** Previous calendar month in UTC, including the January/year boundary. */
  static previousMonthKey(now = new Date()): string {
    return previousUtcMonthKey(now);
  }

  /** @deprecated Use the static helper; retained for older internal callers. */
  private previousMonthKey(): string {
    return previousUtcMonthKey();
  }

  /** Resolve and validate the caller's live building before any scheduler query. */
  private async activeBuildingId(
    user: AuthenticatedUser,
    requestedBuildingId?: string,
  ): Promise<string> {
    if (!user?.id || !user.buildingId) {
      throw new ForbiddenException('An active building is required');
    }
    if (
      requestedBuildingId !== undefined &&
      requestedBuildingId !== user.buildingId
    ) {
      throw new ForbiddenException('Access to another building is not allowed');
    }
    if (!ADMIN_ROLES.includes(user.role as (typeof ADMIN_ROLES)[number])) {
      throw new ForbiddenException('Building administrator access is required');
    }

    const hintedStatus = (user as AuthenticatedUser & { status?: string })
      .status;
    if (hintedStatus && hintedStatus !== 'ACTIVE') {
      throw new ForbiddenException('User is not active');
    }

    // JwtStrategy normally loads the current row. Keep this check here as well
    // because scheduler endpoints are sensitive and must not trust a stale
    // token-shaped object when called directly.
    const userDelegate = (
      this.prisma as unknown as {
        user?: { findUnique?: (args: unknown) => Promise<unknown> };
      }
    ).user;
    if (userDelegate?.findUnique) {
      const current = (await userDelegate.findUnique({
        where: { id: user.id },
        select: { buildingId: true, status: true, role: true },
      })) as
        | {
            buildingId: string | null;
            status?: string | null;
            role?: Role | null;
          }
        | null
        | undefined;

      if (current === null) {
        throw new ForbiddenException('User is not active');
      }
      if (current) {
        if (current.status && current.status !== 'ACTIVE') {
          throw new ForbiddenException('User is not active');
        }
        if (
          current.buildingId !== undefined &&
          current.buildingId !== user.buildingId
        ) {
          throw new ForbiddenException(
            'Access to another building is not allowed',
          );
        }
        if (
          current.role &&
          !ADMIN_ROLES.includes(current.role as (typeof ADMIN_ROLES)[number])
        ) {
          throw new ForbiddenException(
            'Building administrator access is required',
          );
        }
      }
    }

    return user.buildingId;
  }

  private async allBuildingIds(): Promise<string[]> {
    const rows = await this.prisma.building.findMany({ select: { id: true } });
    return rows.map((building) => building.id);
  }

  /**
   * Find a real, active administrator for cron work.  The old implementation
   * invented a synthetic id, which is not a User row and consequently breaks
   * foreign keys when recurring expenses are materialized.
   */
  private async findBuildingActor(
    buildingId: string,
  ): Promise<AuthenticatedUser | null> {
    const delegate = (
      this.prisma as unknown as {
        user?: {
          findFirst?: (args: unknown) => Promise<unknown>;
          findMany?: (args: unknown) => Promise<unknown>;
        };
      }
    ).user;
    if (!delegate) return null;

    const where = {
      buildingId,
      role: { in: [...ADMIN_ROLES] },
      status: 'ACTIVE',
    };
    const select = {
      id: true,
      email: true,
      role: true,
      buildingId: true,
      status: true,
    };
    let row: any;
    if (delegate.findFirst) {
      row = await delegate.findFirst({
        where,
        orderBy: { createdAt: 'asc' },
        select,
      });
      // Test doubles sometimes expose both methods but only populate one.
      if (!row && delegate.findMany) {
        const rows = (await delegate.findMany({
          where,
          orderBy: { createdAt: 'asc' },
          select,
          take: 1,
        })) as any[];
        row = rows[0];
      }
    } else if (delegate.findMany) {
      const rows = (await delegate.findMany({
        where,
        orderBy: { createdAt: 'asc' },
        select,
        take: 1,
      })) as any[];
      row = rows[0];
    }

    if (!row || (row.buildingId && row.buildingId !== buildingId)) return null;
    if (row.status && row.status !== 'ACTIVE') return null;
    if (!ADMIN_ROLES.includes(row.role)) return null;

    return {
      id: row.id,
      email: row.email ?? '',
      role: row.role,
      buildingId,
    };
  }

  // ── JobRun ledger and retries ────────────────────────────────────────────

  private async findExistingRun(
    buildingId: string,
    jobType: SchedulerJobType,
    period: string,
  ): Promise<any | null> {
    const delegate = (
      this.prisma as unknown as {
        jobRun?: {
          findFirst?: (args: unknown) => Promise<unknown>;
          findUnique?: (args: unknown) => Promise<unknown>;
        };
      }
    ).jobRun;
    if (!delegate) return null;

    const where = { buildingId, jobType, period };
    if (delegate.findFirst) {
      const row = await delegate.findFirst({ where });
      // Some lightweight test doubles only implement findUnique. Do not make
      // a real Prisma client take that fallback when findFirst answered.
      if (row !== undefined) return row as any | null;
    }
    if (delegate.findUnique) {
      return (await delegate.findUnique({
        where: { buildingId_jobType_period: where },
      })) as any | null;
    }
    return null;
  }

  private canRetry(existing: any, now: Date): boolean {
    if (!existing) return true;
    if (existing.status === 'FAILED') return true;
    if (existing.status !== 'RUNNING') return false;
    // A RUNNING row with a finish timestamp is an interrupted/inconsistent
    // ledger row and is safe to recover as well.
    if (existing.finishedAt) return true;

    const started =
      existing.startedAt instanceof Date
        ? existing.startedAt.getTime()
        : new Date(existing.startedAt ?? NaN).getTime();
    // A malformed/missing timestamp is safer to recover than to leave a run
    // permanently stuck.
    return (
      !Number.isFinite(started) || now.getTime() - started >= STALE_RUN_AFTER_MS
    );
  }

  /**
   * Claim one occurrence. Failed and stale RUNNING rows are reset in place so
   * the existing unique JobRun key remains the idempotency guard without
   * requiring a schema migration.
   */
  private async claimRun(
    buildingId: string,
    jobType: SchedulerJobType,
    period: string,
    now = new Date(),
  ): Promise<ClaimedRun | null> {
    const existing = await this.findExistingRun(buildingId, jobType, period);
    if (existing && !this.canRetry(existing, now)) return null;

    const delegate = (
      this.prisma as unknown as {
        jobRun?: {
          create?: (args: unknown) => Promise<any>;
          update?: (args: unknown) => Promise<any>;
        };
      }
    ).jobRun;
    if (!delegate?.create || !delegate.update) {
      throw new Error('JobRun persistence is not configured');
    }

    if (existing) {
      const updateManyDelegate = delegate as typeof delegate & {
        updateMany?: (args: unknown) => Promise<{ count?: number }>;
      };
      if (updateManyDelegate.updateMany) {
        const claimWhere: Record<string, unknown> = {
          id: existing.id,
          status: existing.status,
        };
        if (existing.status === 'RUNNING' && existing.startedAt) {
          claimWhere.startedAt = existing.startedAt;
        }
        if (existing.status === 'RUNNING' && existing.finishedAt) {
          claimWhere.finishedAt = existing.finishedAt;
        }
        const claimed = await updateManyDelegate.updateMany({
          where: claimWhere,
          data: {
            status: 'RUNNING',
            message: null,
            startedAt: now,
            finishedAt: null,
          },
        });
        if (claimed && typeof claimed.count === 'number' && claimed.count === 0)
          return null;
        return { id: existing.id };
      }
      const updated = await delegate.update({
        where: { id: existing.id },
        data: {
          status: 'RUNNING',
          message: null,
          startedAt: now,
          finishedAt: null,
        },
      });
      return { id: updated?.id ?? existing.id };
    }

    try {
      const created = await delegate.create({
        data: { buildingId, jobType, period, status: 'RUNNING' },
      });
      return { id: created.id };
    } catch (error) {
      // Two replicas can observe a missing row at the same time. If the other
      // replica won the unique-key race, honor its claim instead of duplicating
      // work. A failed/stale winner is still retryable.
      const raced = await this.findExistingRun(buildingId, jobType, period);
      if (raced) {
        if (!this.canRetry(raced, now)) return null;
        const updated = await delegate.update({
          where: { id: raced.id },
          data: {
            status: 'RUNNING',
            message: null,
            startedAt: now,
            finishedAt: null,
          },
        });
        return { id: updated?.id ?? raced.id };
      }
      throw error;
    }
  }

  private async runForBuilding(
    jobType: SchedulerJobType,
    period: string,
    buildingId: string,
    fn: (buildingId: string, user: AuthenticatedUser) => Promise<unknown>,
    suppliedActor?: AuthenticatedUser,
  ): Promise<RunOutcome> {
    const now = new Date();
    const claim = await this.claimRun(buildingId, jobType, period, now);
    if (!claim) return { ran: false, skipped: true, failed: false };

    let actor: AuthenticatedUser | undefined = suppliedActor;
    try {
      if (!actor) {
        actor = (await this.findBuildingActor(buildingId)) ?? undefined;
      }
      if (!actor) {
        throw new Error(
          'No active owner/admin is available for scheduler work',
        );
      }

      const result = await fn(buildingId, actor);
      const finishedAt = new Date();
      await (this.prisma as any).jobRun.update({
        where: { id: claim.id },
        data: {
          status: 'SUCCESS',
          message: safeMessage(result),
          finishedAt,
        },
      });
      this.audit.record({
        buildingId,
        actorId: actor.id,
        actorRole: actor.role,
        action: `scheduler.${jobType}`,
        entity: 'job_run',
        entityId: claim.id,
        metadata: { period, startedAt: now.toISOString() },
      });
      return { ran: true, skipped: false, failed: false };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      try {
        await (this.prisma as any).jobRun.update({
          where: { id: claim.id },
          data: { status: 'FAILED', message, finishedAt: new Date() },
        });
      } catch (updateError) {
        this.logger.error(
          `scheduler ${jobType} could not record failure for building ${buildingId}: ${String(updateError)}`,
        );
      }
      this.logger.error(
        `scheduler ${jobType} failed for building ${buildingId}: ${message}`,
      );
      return { ran: true, skipped: false, failed: true };
    }
  }

  /** Run a job for every building, subject to the cron gate. */
  private async runForAllBuildings(
    jobType: SchedulerJobType,
    period: string,
    fn: (buildingId: string, user: AuthenticatedUser) => Promise<unknown>,
    enabled = isSchedulerEnabled(),
  ): Promise<void> {
    if (!enabled) return;
    for (const buildingId of await this.allBuildingIds()) {
      await this.runForBuilding(jobType, period, buildingId, fn);
    }
  }

  /**
   * A daily occurrence gets a new date key, so a failure from yesterday would
   * otherwise never be revisited. Retry one older failed/stale occurrence
   * before starting today's occurrence. The existing JobRun status/start
   * fields are sufficient; no attempt counter or schema change is needed.
   */
  private async runDailyForAllBuildings(
    jobType: SchedulerJobType,
    period: string,
    fn: (buildingId: string, user: AuthenticatedUser) => Promise<unknown>,
  ): Promise<void> {
    if (!isSchedulerEnabled()) return;
    for (const buildingId of await this.allBuildingIds()) {
      await this.retryPendingDailyRun(jobType, period, buildingId, fn);
      await this.runForBuilding(jobType, period, buildingId, fn);
    }
  }

  private async retryPendingDailyRun(
    jobType: SchedulerJobType,
    currentPeriod: string,
    buildingId: string,
    fn: (buildingId: string, user: AuthenticatedUser) => Promise<unknown>,
    suppliedActor?: AuthenticatedUser,
  ): Promise<void> {
    if (!DAILY_JOB_TYPES.has(jobType)) return;
    const delegate = (
      this.prisma as unknown as {
        jobRun?: { findFirst?: (args: unknown) => Promise<unknown> };
      }
    ).jobRun;
    if (!delegate?.findFirst) return;

    const pending = (await delegate.findFirst({
      where: {
        buildingId,
        jobType,
        status: { in: ['FAILED', 'RUNNING'] },
        period: { not: currentPeriod },
      },
      orderBy: { startedAt: 'asc' },
    })) as {
      period?: string | null;
      status?: string;
      startedAt?: Date | string;
      finishedAt?: Date | string | null;
    } | null;
    if (!pending?.period || !this.canRetry(pending, new Date())) return;

    await this.runForBuilding(
      jobType,
      pending.period,
      buildingId,
      fn,
      suppliedActor,
    );
  }

  // ── Cron jobs ───────────────────────────────────────────────────────────

  @Cron('0 5 1 * *')
  async recurringGen(): Promise<void> {
    const period = this.previousMonthKey();
    await this.runForAllBuildings('recurring_gen', period, (buildingId, user) =>
      this.recurring.generate(buildingId, period, user),
    );
  }

  @Cron('0 6 1 * *')
  async invoiceRun(): Promise<void> {
    const period = this.previousMonthKey();
    if (!isSchedulerEnabled()) return;
    // Recurring expenses are the input to invoice aggregation. The separate
    // 05:00 cron normally wins this race; this prerequisite also repairs a
    // failed/missed recurring run before invoices are attempted.
    for (const buildingId of await this.allBuildingIds()) {
      await this.runForBuilding(
        'recurring_gen',
        period,
        buildingId,
        (id, user) => this.recurring.generate(id, period, user),
      );
      await this.runForBuilding('invoice_run', period, buildingId, (id, user) =>
        this.invoices.run(id, { periodYearMonth: period }, user),
      );
    }
  }

  @Cron('0 8 1 * *')
  async lateFeeRun(): Promise<void> {
    const period = this.previousMonthKey();
    await this.runForAllBuildings('late_fee', period, (buildingId, user) =>
      this.lateFees.run(buildingId, { month: period }, user),
    );
  }

  @Cron('0 9 * * *')
  async remindersRun(): Promise<void> {
    const period = utcDateKey();
    await this.runDailyForAllBuildings(
      'reminders',
      period,
      (buildingId, user) => this.reminders.send(buildingId, undefined, user),
    );
  }

  @Cron('30 9 * * *')
  async maintenanceJobs(): Promise<void> {
    const period = utcDateKey();
    await this.runDailyForAllBuildings(
      'maintenance_jobs',
      period,
      (buildingId, user) => this.maintenance.generateDueJobs(buildingId, user),
    );
  }

  @Cron('0 10 * * *')
  async complianceCheck(): Promise<void> {
    const period = utcDateKey();
    await this.runDailyForAllBuildings(
      'compliance_check',
      period,
      (buildingId, user) => this.compliance.checkExpiries(buildingId, user),
    );
  }

  @Cron('0 7 * * 1')
  async kpiSnapshot(): Promise<void> {
    const period = weekOccurrenceKey(new Date());
    await this.runForAllBuildings('kpi_snapshot', period, (buildingId, user) =>
      this.requireKpi().snapshot(buildingId, user),
    );
  }

  @Cron('15 7 * * 1')
  async kpiAnomalies(): Promise<void> {
    const period = weekOccurrenceKey(new Date());
    await this.runForAllBuildings('kpi_anomaly', period, (buildingId, user) =>
      this.requireKpi().checkAnomalies(buildingId, user),
    );
  }

  /** Feature 4: auto-close + tally every overdue, un-closed vote. */
  @Cron('*/10 * * * *')
  async voteClose(): Promise<void> {
    if (!isSchedulerEnabled()) return;
    await this.closeOverdueVotes();
  }

  private async closeOverdueVotes(
    buildingId?: string,
    suppliedActor?: AuthenticatedUser,
  ): Promise<RunOutcome[]> {
    const votes = await this.prisma.vote.findMany({
      where: {
        ...(buildingId ? { buildingId } : {}),
        closesAt: { lt: new Date() },
        result: null,
      },
      select: { id: true, buildingId: true },
    });
    const outcomes: RunOutcome[] = [];
    for (const vote of votes) {
      outcomes.push(
        await this.runForBuilding(
          'vote_close',
          vote.id,
          vote.buildingId,
          (id, user) => this.votes.close(id, user),
          suppliedActor,
        ),
      );
    }
    return outcomes;
  }

  // ── Manual endpoint operations ───────────────────────────────────────────

  private requireKpi(): KpiService {
    if (!this.kpi) throw new Error('KPI service is not configured');
    return this.kpi;
  }

  private async executeJob(
    jobType: SchedulerJobType,
    buildingId: string,
    period: string,
    user: AuthenticatedUser,
  ): Promise<unknown> {
    switch (jobType) {
      case 'invoice_run':
        return this.invoices.run(buildingId, { periodYearMonth: period }, user);
      case 'recurring_gen':
        return this.recurring.generate(buildingId, period, user);
      case 'late_fee':
        return this.lateFees.run(buildingId, { month: period }, user);
      case 'reminders':
        return this.reminders.send(buildingId, undefined, user);
      case 'maintenance_jobs':
        return this.maintenance.generateDueJobs(buildingId, user);
      case 'compliance_check':
        return this.compliance.checkExpiries(buildingId, user);
      case 'kpi_snapshot':
        return this.requireKpi().snapshot(buildingId, user);
      case 'kpi_anomaly':
        return this.requireKpi().checkAnomalies(buildingId, user);
      case 'vote_close':
        throw new BadRequestException('vote_close is triggered per vote');
      default:
        throw new BadRequestException(`Unsupported scheduler job: ${jobType}`);
    }
  }

  /**
   * Manual trigger. Unlike the cron wrapper this method deliberately does not
   * consult JOB_SCHEDULER_ENABLED, so an operator can recover a failed run on a
   * non-job replica. The returned `cronEnabled` makes the state explicit.
   */
  async trigger(
    jobType: SchedulerJobType,
    user: AuthenticatedUser,
    period?: string,
    requestedBuildingId?: string,
  ): Promise<SchedulerTriggerResult>;
  /** Compatibility overload for callers that kept the old period-first API. */
  async trigger(
    jobType: SchedulerJobType,
    period: string | undefined,
    user: AuthenticatedUser,
    requestedBuildingId?: string,
  ): Promise<SchedulerTriggerResult>;
  async trigger(
    jobType: SchedulerJobType,
    userOrPeriod?: AuthenticatedUser | string,
    periodOrUser?: string | AuthenticatedUser,
    requestedBuildingId?: string,
  ): Promise<SchedulerTriggerResult> {
    const {
      user,
      period,
      buildingId: requested,
    } = normalizeTriggerArguments(
      userOrPeriod,
      periodOrUser,
      requestedBuildingId,
    );
    const buildingId = await this.activeBuildingId(user, requested);
    const cronEnabled = isSchedulerEnabled();

    if (jobType === 'vote_close') {
      const outcomes = await this.closeOverdueVotes(buildingId, user);
      return summarizeTrigger(jobType, buildingId, null, outcomes, cronEnabled);
    }

    const resolvedPeriod = resolveManualPeriod(jobType, period);
    if (DAILY_JOB_TYPES.has(jobType)) {
      await this.retryPendingDailyRun(
        jobType,
        resolvedPeriod,
        buildingId,
        (id, actor) => this.executeJob(jobType, id, resolvedPeriod, actor),
        user,
      );
    }
    if (jobType === 'invoice_run') {
      const recurringOutcome = await this.runForBuilding(
        'recurring_gen',
        resolvedPeriod,
        buildingId,
        (id, actor) => this.recurring.generate(id, resolvedPeriod, actor),
        user,
      );
      const invoiceOutcome = await this.runForBuilding(
        'invoice_run',
        resolvedPeriod,
        buildingId,
        (id, actor) =>
          this.invoices.run(id, { periodYearMonth: resolvedPeriod }, actor),
        user,
      );
      return summarizeTrigger(
        jobType,
        buildingId,
        resolvedPeriod,
        [recurringOutcome, invoiceOutcome],
        cronEnabled,
      );
    }

    const outcome = await this.runForBuilding(
      jobType,
      resolvedPeriod,
      buildingId,
      (id, actor) => this.executeJob(jobType, id, resolvedPeriod, actor),
      user,
    );
    return summarizeTrigger(
      jobType,
      buildingId,
      resolvedPeriod,
      [outcome],
      cronEnabled,
    );
  }

  async history(
    user: AuthenticatedUser,
    limit?: number,
    requestedBuildingId?: string,
  ): Promise<JobRunView[]>;
  /** Compatibility overload for the old limit-first service signature. */
  async history(
    limit: number,
    user: AuthenticatedUser,
    requestedBuildingId?: string,
  ): Promise<JobRunView[]>;
  async history(
    userOrLimit: AuthenticatedUser | number,
    limitOrUser?: number | AuthenticatedUser,
    requestedBuildingId?: string,
  ): Promise<JobRunView[]> {
    const {
      user,
      limit,
      buildingId: requested,
    } = normalizeHistoryArguments(
      userOrLimit,
      limitOrUser,
      requestedBuildingId,
    );
    const buildingId = await this.activeBuildingId(user, requested);
    const take = boundedHistoryLimit(limit);
    const rows = await this.prisma.jobRun.findMany({
      where: { buildingId },
      orderBy: { startedAt: 'desc' },
      take,
    });
    return rows.map((row) => ({
      id: row.id,
      buildingId: row.buildingId,
      jobType: row.jobType as SchedulerJobType,
      period: row.period,
      status: row.status,
      message: row.message,
      startedAt: row.startedAt.toISOString(),
      finishedAt: row.finishedAt ? row.finishedAt.toISOString() : null,
    }));
  }
}

function normalizeTriggerArguments(
  userOrPeriod: AuthenticatedUser | string | undefined,
  periodOrUser: string | AuthenticatedUser | undefined,
  requestedBuildingId?: string,
): { user: AuthenticatedUser; period?: string; buildingId?: string } {
  if (typeof userOrPeriod === 'string' || userOrPeriod === undefined) {
    if (!periodOrUser || typeof periodOrUser !== 'object') {
      throw new ForbiddenException(
        'An authenticated building administrator is required',
      );
    }
    return {
      user: periodOrUser,
      period: userOrPeriod,
      buildingId: requestedBuildingId,
    };
  }
  return {
    user: userOrPeriod,
    period: typeof periodOrUser === 'string' ? periodOrUser : undefined,
    buildingId: requestedBuildingId,
  };
}

function normalizeHistoryArguments(
  userOrLimit: AuthenticatedUser | number,
  limitOrUser?: number | AuthenticatedUser,
  requestedBuildingId?: string,
): { user: AuthenticatedUser; limit?: number; buildingId?: string } {
  if (typeof userOrLimit === 'number') {
    if (!limitOrUser || typeof limitOrUser !== 'object') {
      throw new ForbiddenException(
        'An authenticated building administrator is required',
      );
    }
    return {
      user: limitOrUser,
      limit: userOrLimit,
      buildingId: requestedBuildingId,
    };
  }
  return {
    user: userOrLimit,
    limit: typeof limitOrUser === 'number' ? limitOrUser : undefined,
    buildingId: requestedBuildingId,
  };
}

function previousUtcMonthKey(now = new Date()): string {
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth(); // 0 = January
  const previous = new Date(Date.UTC(year, month - 1, 1));
  return `${String(previous.getUTCFullYear()).padStart(4, '0')}-${String(
    previous.getUTCMonth() + 1,
  ).padStart(2, '0')}`;
}

function utcDateKey(now = new Date()): string {
  return `${String(now.getUTCFullYear()).padStart(4, '0')}-${String(
    now.getUTCMonth() + 1,
  ).padStart(2, '0')}-${String(now.getUTCDate()).padStart(2, '0')}`;
}

function weekOccurrenceKey(now = new Date()): string {
  const day = now.getUTCDay();
  const monday = new Date(
    Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate() + (day === 0 ? -6 : 1 - day),
    ),
  );
  return utcDateKey(monday);
}

function resolveManualPeriod(
  jobType: SchedulerJobType,
  requested?: string,
): string {
  switch (jobType) {
    case 'invoice_run':
    case 'recurring_gen':
    case 'late_fee':
      return requireValidPeriod(requested ?? previousUtcMonthKey());
    case 'kpi_snapshot':
    case 'kpi_anomaly':
      if (requested && /^\d{4}-\d{2}-\d{2}$/.test(requested)) return requested;
      return weekOccurrenceKey();
    case 'reminders':
    case 'maintenance_jobs':
    case 'compliance_check':
      if (requested && /^\d{4}-\d{2}-\d{2}$/.test(requested)) return requested;
      return utcDateKey();
    case 'vote_close':
      throw new BadRequestException('vote_close is triggered per vote');
    default:
      throw new BadRequestException(`Unsupported scheduler job: ${jobType}`);
  }
}

function boundedHistoryLimit(limit?: number): number {
  if (limit === undefined || !Number.isFinite(limit))
    return DEFAULT_HISTORY_LIMIT;
  return Math.min(Math.max(Math.floor(limit), 1), MAX_HISTORY_LIMIT);
}

function summarizeTrigger(
  jobType: SchedulerJobType,
  buildingId: string,
  period: string | null,
  outcomes: RunOutcome[],
  cronEnabled: boolean,
): SchedulerTriggerResult {
  const failed = outcomes.filter((outcome) => outcome.failed).length;
  const skipped = outcomes.filter((outcome) => outcome.skipped).length;
  const ran = outcomes.filter((outcome) => outcome.ran).length;
  return {
    accepted: true,
    success: failed === 0,
    cronEnabled,
    buildingId,
    jobType,
    period,
    ran,
    skipped,
    failed,
  };
}

function safeMessage(result: unknown): string | null {
  if (result === undefined || result === null) return null;
  if (typeof result === 'string') return result.slice(0, 400);
  try {
    return JSON.stringify(result).slice(0, 400);
  } catch {
    return null;
  }
}

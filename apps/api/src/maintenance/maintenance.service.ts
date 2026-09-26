import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Role } from '@prisma/client';

import { AuditService } from '../audit/audit.service';
import type { AuthenticatedUser } from '../auth/auth.types';
import { assertSameBuilding, membershipUserIds } from '../common/tenant';
import { NotificationsService } from '../notifications/notifications.service';
import { PrismaService } from '../prisma/prisma.service';
import { CreateAssetDto, ASSET_CATEGORIES } from './dto/create-asset.dto';
import { UpdateAssetDto } from './dto/update-asset.dto';
import { CreateScheduleDto } from './dto/create-schedule.dto';
import { UpdateScheduleDto } from './dto/update-schedule.dto';
import { MarkDoneDto } from './dto/mark-done.dto';

const MS_PER_DAY = 86_400_000;
const DEFAULT_UPCOMING_DAYS = 30;
const GENERATE_WINDOW_DAYS = 30;
const MAINTENANCE_DUE_TYPE = 'maintenance.due';
const MAINTENANCE_LINK_PATH = '/admin/maintenance';
export const MAINTENANCE_JOB_SOURCE = 'MAINTENANCE_SCHEDULE';
export const MAINTENANCE_JOB_TYPE = 'maintenance.schedule';

export function maintenanceJobType(scheduleId: string): string {
  return `${MAINTENANCE_JOB_TYPE}:${scheduleId}`;
}

/**
 * Stable identity for one due occurrence.  The schedule row itself is not an
 * occurrence: after markDone its nextDueAt changes and a new job is due.  A
 * schedule id + exact UTC due timestamp is therefore the idempotency key.
 */
export function maintenanceOccurrenceKey(scheduleId: string, nextDueAt: Date): string {
  return `${scheduleId}@${nextDueAt.toISOString()}`;
}

export const ASSET_CATEGORY_VALUES: string[] = [...ASSET_CATEGORIES];

/** UTC calendar days from now until due; negative when overdue */
export function daysUntilDue(dueAt: Date, now: Date): number {
  const utcDay = (d: Date) => Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  return Math.round((utcDay(dueAt) - utcDay(now)) / MS_PER_DAY);
}

export function addMonths(date: Date, months: number): Date {
  const d = new Date(date);
  // Use UTC to avoid DST skew and preserve time-of-day
  const utcYear = d.getUTCFullYear();
  const utcMonth = d.getUTCMonth();
  const utcDate = d.getUTCDate();
  const utcHours = d.getUTCHours();
  const utcMinutes = d.getUTCMinutes();
  const utcSeconds = d.getUTCSeconds();
  const utcMs = d.getUTCMilliseconds();
  const target = new Date(Date.UTC(utcYear, utcMonth + months, utcDate, utcHours, utcMinutes, utcSeconds, utcMs));
  return target;
}

function parseUpcomingDays(raw: string | number | undefined): number {
  if (raw === undefined || raw === '' || raw === null) return DEFAULT_UPCOMING_DAYS;
  const value = typeof raw === 'string' ? Number(raw) : raw;
  if (!Number.isInteger(value) || value < 0) {
    throw new BadRequestException('upcomingDays must be a non-negative integer');
  }
  return value;
}

function parseCategory(category: string | undefined): string | undefined {
  if (category === undefined || category === '' || category === null) return undefined;
  if (!ASSET_CATEGORY_VALUES.includes(category)) {
    throw new BadRequestException(`Invalid category: ${category}`);
  }
  return category;
}

function isUniqueConflict(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: string }).code === 'P2002'
  );
}

@Injectable()
export class MaintenanceService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
  ) {}

  // ──────────────────────────────────────────────
  // Assets
  // ──────────────────────────────────────────────

  async listAssets(
    buildingId: string,
    user: AuthenticatedUser,
    category?: string,
  ) {
    assertSameBuilding(user, buildingId);
    const cat = parseCategory(category);
    const assets = await (this.prisma as any).buildingAsset.findMany({
      where: {
        buildingId,
        ...(cat ? { category: cat } : {}),
      },
      orderBy: { createdAt: 'desc' },
    });
    return assets.map((a: any) => this.toAssetDto(a));
  }

  async createAsset(
    buildingId: string,
    dto: CreateAssetDto,
    user: AuthenticatedUser,
  ) {
    assertSameBuilding(user, buildingId);
    // category already validated by DTO; double-check
    parseCategory(dto.category as unknown as string);
    const asset = await (this.prisma as any).buildingAsset.create({
      data: {
        buildingId,
        name: dto.name,
        category: dto.category,
        ...(dto.location !== undefined ? { location: dto.location } : {}),
        ...(dto.installedAt !== undefined ? { installedAt: new Date(dto.installedAt) } : {}),
        ...(dto.notes !== undefined ? { notes: dto.notes } : {}),
      },
    });
    this.audit.record({
      buildingId,
      actorId: user.id,
      actorRole: user.role,
      action: 'maintenance.asset.created',
      entity: 'building_asset',
      entityId: (asset as any).id,
      metadata: { name: (asset as any).name, category: (asset as any).category },
    });
    return this.toAssetDto(asset as any);
  }

  async updateAsset(
    buildingId: string,
    assetId: string,
    dto: UpdateAssetDto,
    user: AuthenticatedUser,
  ) {
    assertSameBuilding(user, buildingId);
    const asset = await this.findOwnedAsset(buildingId, assetId);
    if (dto.category !== undefined) parseCategory(dto.category as unknown as string);
    const updated = await (this.prisma as any).buildingAsset.update({
      where: { id: asset.id },
      data: {
        ...(dto.name !== undefined ? { name: dto.name } : {}),
        ...(dto.category !== undefined ? { category: dto.category } : {}),
        ...(dto.location !== undefined ? { location: dto.location } : {}),
        ...(dto.installedAt !== undefined
          ? { installedAt: dto.installedAt ? new Date(dto.installedAt) : null }
          : {}),
        ...(dto.notes !== undefined ? { notes: dto.notes } : {}),
      },
    });
    this.audit.record({
      buildingId,
      actorId: user.id,
      actorRole: user.role,
      action: 'maintenance.asset.updated',
      entity: 'building_asset',
      entityId: (updated as any).id,
      metadata: { name: (updated as any).name },
    });
    return this.toAssetDto(updated as any);
  }

  async deleteAsset(buildingId: string, assetId: string, user: AuthenticatedUser) {
    assertSameBuilding(user, buildingId);
    const asset = await this.findOwnedAsset(buildingId, assetId);
    await (this.prisma as any).buildingAsset.delete({ where: { id: asset.id } });
    this.audit.record({
      buildingId,
      actorId: user.id,
      actorRole: user.role,
      action: 'maintenance.asset.deleted',
      entity: 'building_asset',
      entityId: asset.id,
      metadata: { name: (asset as any).name },
    });
  }

  // ──────────────────────────────────────────────
  // Schedules
  // ──────────────────────────────────────────────

  async listSchedules(
    buildingId: string,
    user: AuthenticatedUser,
    query: { upcomingDays?: string; category?: string } = {},
  ) {
    assertSameBuilding(user, buildingId);
    const upcomingDays = parseUpcomingDays(query.upcomingDays as any);
    const category = parseCategory(query.category);
    const now = new Date();
    const cutoff = new Date(now.getTime() + upcomingDays * MS_PER_DAY);

    // Prisma where with relation filter for category via asset
    const where: any = {
      buildingId,
      nextDueAt: { lte: cutoff },
      ...(category ? { asset: { category } } : {}),
    };

    const schedules = await (this.prisma as any).maintenanceSchedule.findMany({
      where,
      include: { asset: true },
      orderBy: { nextDueAt: 'asc' },
    });

    return schedules.map((s: any) => this.toScheduleDto(s, now));
  }

  async createSchedule(
    buildingId: string,
    dto: CreateScheduleDto,
    user: AuthenticatedUser,
  ) {
    assertSameBuilding(user, buildingId);
    if (!Number.isInteger(dto.intervalMonths) || dto.intervalMonths < 1) {
      throw new BadRequestException('intervalMonths must be >= 1');
    }
    // Validate asset belongs to building
    const asset = await (this.prisma as any).buildingAsset.findFirst({
      where: { id: dto.assetId, buildingId },
    });
    if (!asset) throw new NotFoundException('Asset not found for this building');

    if (dto.expenseCategoryId) {
      await this.assertExpenseCategory(buildingId, dto.expenseCategoryId);
    }

    const now = new Date();
    const base = dto.lastDoneAt ? new Date(dto.lastDoneAt) : now;
    if (Number.isNaN(base.getTime())) throw new BadRequestException('Invalid lastDoneAt');
    const nextDueAt = addMonths(base, dto.intervalMonths);

    const schedule = await (this.prisma as any).maintenanceSchedule.create({
      data: {
        assetId: dto.assetId,
        buildingId,
        title: dto.title,
        intervalMonths: dto.intervalMonths,
        ...(dto.lastDoneAt ? { lastDoneAt: new Date(dto.lastDoneAt) } : {}),
        nextDueAt,
        ...(dto.autoCreateJob !== undefined ? { autoCreateJob: dto.autoCreateJob } : {}),
        ...(dto.expenseCategoryId ? { expenseCategoryId: dto.expenseCategoryId } : {}),
      },
      include: { asset: true },
    });

    this.audit.record({
      buildingId,
      actorId: user.id,
      actorRole: user.role,
      action: 'maintenance.schedule.created',
      entity: 'maintenance_schedule',
      entityId: (schedule as any).id,
      metadata: { title: (schedule as any).title, assetId: dto.assetId },
    });
    return this.toScheduleDto(schedule as any, now);
  }

  async updateSchedule(
    buildingId: string,
    scheduleId: string,
    dto: UpdateScheduleDto,
    user: AuthenticatedUser,
  ) {
    assertSameBuilding(user, buildingId);
    const schedule = await this.findOwnedSchedule(buildingId, scheduleId);

    if (dto.intervalMonths !== undefined && (!Number.isInteger(dto.intervalMonths) || dto.intervalMonths < 1)) {
      throw new BadRequestException('intervalMonths must be >= 1');
    }

    if (dto.assetId) {
      const asset = await (this.prisma as any).buildingAsset.findFirst({
        where: { id: dto.assetId, buildingId },
      });
      if (!asset) throw new NotFoundException('Asset not found for this building');
    }

    if (dto.expenseCategoryId) {
      await this.assertExpenseCategory(buildingId, dto.expenseCategoryId);
    }

    // Recompute nextDueAt if interval or lastDoneAt changes
    let nextDueAtUpdate: Date | undefined;
    if (dto.intervalMonths !== undefined || dto.lastDoneAt !== undefined) {
      const interval = dto.intervalMonths ?? (schedule as any).intervalMonths;
      const lastDoneRaw = dto.lastDoneAt !== undefined ? dto.lastDoneAt : (schedule as any).lastDoneAt?.toISOString?.() ?? null;
      const base = lastDoneRaw ? new Date(lastDoneRaw) : new Date();
      if (Number.isNaN(base.getTime())) throw new BadRequestException('Invalid lastDoneAt');
      nextDueAtUpdate = addMonths(base, interval);
    }

    const updated = await (this.prisma as any).maintenanceSchedule.update({
      where: { id: schedule.id },
      data: {
        ...(dto.assetId !== undefined ? { assetId: dto.assetId } : {}),
        ...(dto.title !== undefined ? { title: dto.title } : {}),
        ...(dto.intervalMonths !== undefined ? { intervalMonths: dto.intervalMonths } : {}),
        ...(dto.lastDoneAt !== undefined
          ? { lastDoneAt: dto.lastDoneAt ? new Date(dto.lastDoneAt) : null }
          : {}),
        ...(nextDueAtUpdate ? { nextDueAt: nextDueAtUpdate } : {}),
        ...(dto.autoCreateJob !== undefined ? { autoCreateJob: dto.autoCreateJob } : {}),
        ...(dto.expenseCategoryId !== undefined ? { expenseCategoryId: dto.expenseCategoryId } : {}),
      },
      include: { asset: true },
    });

    this.audit.record({
      buildingId,
      actorId: user.id,
      actorRole: user.role,
      action: 'maintenance.schedule.updated',
      entity: 'maintenance_schedule',
      entityId: (updated as any).id,
      metadata: { title: (updated as any).title },
    });
    return this.toScheduleDto(updated as any, new Date());
  }

  async deleteSchedule(buildingId: string, scheduleId: string, user: AuthenticatedUser) {
    assertSameBuilding(user, buildingId);
    const schedule = await this.findOwnedSchedule(buildingId, scheduleId);
    await (this.prisma as any).maintenanceSchedule.delete({ where: { id: schedule.id } });
    this.audit.record({
      buildingId,
      actorId: user.id,
      actorRole: user.role,
      action: 'maintenance.schedule.deleted',
      entity: 'maintenance_schedule',
      entityId: schedule.id,
      metadata: { title: (schedule as any).title },
    });
  }

  async markDone(
    buildingId: string,
    scheduleId: string,
    _dto: MarkDoneDto,
    user: AuthenticatedUser,
  ) {
    assertSameBuilding(user, buildingId);
    const schedule = await this.findOwnedSchedule(buildingId, scheduleId);
    const now = new Date();
    const nextDueAt = addMonths(now, (schedule as any).intervalMonths);
    const updated = await (this.prisma as any).maintenanceSchedule.update({
      where: { id: schedule.id },
      data: {
        lastDoneAt: now,
        nextDueAt,
      },
      include: { asset: true },
    });
    this.audit.record({
      buildingId,
      actorId: user.id,
      actorRole: user.role,
      action: 'maintenance.schedule.mark_done',
      entity: 'maintenance_schedule',
      entityId: (updated as any).id,
      metadata: { title: (updated as any).title, intervalMonths: (updated as any).intervalMonths },
    });
    return this.toScheduleDto(updated as any, now);
  }

  /**
   * Finds schedules due in the next 30 days and materializes one job per
   * schedule occurrence. JobRun's unique (buildingId, jobType, period) key is
   * the concurrency-safe occurrence ledger; the marker in the description is a
   * useful migration/debug fallback for installations without JobRun rows.
   */
  async generateDueJobs(buildingId: string, user: AuthenticatedUser) {
    assertSameBuilding(user, buildingId);
    const now = new Date();
    const cutoff = new Date(now.getTime() + GENERATE_WINDOW_DAYS * MS_PER_DAY);

    const due = await (this.prisma as any).maintenanceSchedule.findMany({
      where: {
        buildingId,
        autoCreateJob: true,
        nextDueAt: { lte: cutoff },
      },
      include: { asset: true },
    });

    if (due.length === 0) {
      return { created: 0, skipped: 0 };
    }

    const db = this.prisma as any;
    const admins = db.membership
      ? await membershipUserIds(this.prisma, buildingId, [
          Role.ADMIN,
          Role.BUILDING_OWNER,
        ])
      : await db.user.findMany({
          where: { role: Role.ADMIN, buildingId },
          select: { id: true },
        }).then((rows: Array<{ id: string }>) => rows.map((row) => row.id));

    let created = 0;
    let skipped = 0;

    for (const schedule of due as any[]) {
      const occurrence = maintenanceOccurrenceKey(schedule.id, schedule.nextDueAt);
      const period = schedule.nextDueAt.toISOString();
      const description = `${schedule.title} — ${schedule.asset?.name ?? 'Asset'} (προγραμματισμένη συντήρηση) [${occurrence}]`;
      let madeJob = false;

      try {
        if (
          db.jobRun?.create &&
          db.jobRun.update &&
          typeof db.$transaction === 'function'
        ) {
          await db.$transaction(async (tx: any) => {
            // The unique JobRun row is claimed before the Job insert. A second
            // scheduler/replica gets P2002 and skips this occurrence.
            const run = await tx.jobRun.create({
              data: {
                buildingId,
                jobType: maintenanceJobType(schedule.id),
                period,
                status: 'RUNNING',
              },
            });
            await tx.job.create({
              data: {
                buildingId,
                title: schedule.title,
                description,
                status: 'OPEN',
                source: MAINTENANCE_JOB_SOURCE,
              },
            });
            await tx.jobRun.update({
              where: { id: run.id },
              data: { status: 'SUCCESS', finishedAt: new Date() },
            });
          });
        } else {
          // Legacy/test fallback. Do not use this broad title check when the
          // real JobRun ledger is available; it would suppress the next
          // occurrence months later.
          const existing = await db.job.findFirst({
            where: {
              buildingId,
              source: MAINTENANCE_JOB_SOURCE,
              description: { contains: `[${occurrence}]` },
            },
          });
          if (existing) {
            skipped += 1;
            continue;
          }
          await db.job.create({
            data: {
              buildingId,
              title: schedule.title,
              description,
              status: 'OPEN',
              source: MAINTENANCE_JOB_SOURCE,
            },
          });
        }
        madeJob = true;
        created += 1;
      } catch (error: unknown) {
        if (isUniqueConflict(error)) {
          skipped += 1;
          continue;
        }
        throw error;
      }

      if (madeJob && admins.length > 0) {
        await this.notifications.createForUsers(admins, {
          type: MAINTENANCE_DUE_TYPE,
          title: `Συντήρηση οφειλόμενη: ${schedule.title}`,
          body: `${schedule.asset?.name ?? ''} — λήξη ${schedule.nextDueAt?.toISOString?.().slice(0, 10) ?? ''}`,
          linkPath: MAINTENANCE_LINK_PATH,
        });
      }
    }

    if (created > 0 || skipped > 0) {
      this.audit.record({
        buildingId,
        actorId: user.id,
        actorRole: user.role,
        action: 'maintenance.generate_jobs',
        entity: 'maintenance_schedule',
        entityId: null,
        metadata: { created, skipped, due: due.length },
      });
    }

    return { created, skipped };
  }

  async getCalendar(
    buildingId: string,
    user: AuthenticatedUser,
    query: { from?: string; to?: string } = {},
  ) {
    assertSameBuilding(user, buildingId);

    const now = new Date();
    let from: Date;
    let to: Date;
    if (query.from) {
      from = new Date(query.from);
      if (Number.isNaN(from.getTime())) throw new BadRequestException('Invalid from date');
    } else {
      from = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    }
    if (query.to) {
      to = new Date(query.to);
      if (Number.isNaN(to.getTime())) throw new BadRequestException('Invalid to date');
    } else {
      to = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0, 23, 59, 59, 999));
    }
    if (from.getTime() > to.getTime()) {
      throw new BadRequestException('from must be before to');
    }

    const [assets, schedules] = await Promise.all([
      (this.prisma as any).buildingAsset.findMany({
        where: { buildingId },
        orderBy: { name: 'asc' },
      }),
      (this.prisma as any).maintenanceSchedule.findMany({
        where: {
          buildingId,
          nextDueAt: { gte: from, lte: to },
        },
        include: { asset: true },
        orderBy: { nextDueAt: 'asc' },
      }),
    ]);

    const events = (schedules as any[]).map((s) => {
      const daysLeft = daysUntilDue(s.nextDueAt, now);
      let status: 'overdue' | 'urgent' | 'upcoming' = 'upcoming';
      if (daysLeft < 0) status = 'overdue';
      else if (daysLeft <= 7) status = 'urgent';
      return {
        id: s.id,
        title: s.title,
        assetId: s.assetId,
        assetName: s.asset?.name ?? null,
        category: s.asset?.category ?? null,
        dueAt: s.nextDueAt.toISOString(),
        lastDoneAt: s.lastDoneAt ? s.lastDoneAt.toISOString() : null,
        intervalMonths: s.intervalMonths,
        daysLeft,
        status,
        autoCreateJob: s.autoCreateJob,
      };
    });

    return {
      from: from.toISOString(),
      to: to.toISOString(),
      assets: (assets as any[]).map((a) => this.toAssetDto(a)),
      schedules: (schedules as any[]).map((s) => this.toScheduleDto(s, now)),
      events,
    };
  }

  // ──────────────────────────────────────────────
  // Helpers
  // ──────────────────────────────────────────────

  private toAssetDto(asset: any) {
    return {
      id: asset.id,
      buildingId: asset.buildingId,
      name: asset.name,
      category: asset.category,
      location: asset.location ?? null,
      installedAt: asset.installedAt ? asset.installedAt.toISOString() : null,
      notes: asset.notes ?? null,
      createdAt: asset.createdAt ? asset.createdAt.toISOString() : new Date().toISOString(),
    };
  }

  private toScheduleDto(schedule: any, now: Date) {
    const daysLeft = daysUntilDue(schedule.nextDueAt, now);
    let status: 'overdue' | 'urgent' | 'upcoming' = 'upcoming';
    if (daysLeft < 0) status = 'overdue';
    else if (daysLeft <= 7) status = 'urgent';
    return {
      id: schedule.id,
      assetId: schedule.assetId,
      buildingId: schedule.buildingId,
      title: schedule.title,
      intervalMonths: schedule.intervalMonths,
      lastDoneAt: schedule.lastDoneAt ? schedule.lastDoneAt.toISOString() : null,
      nextDueAt: schedule.nextDueAt.toISOString(),
      autoCreateJob: schedule.autoCreateJob,
      expenseCategoryId: schedule.expenseCategoryId ?? null,
      asset: schedule.asset
        ? {
            id: schedule.asset.id,
            name: schedule.asset.name,
            category: schedule.asset.category,
          }
        : null,
      daysLeft,
      status,
      createdAt: schedule.createdAt ? schedule.createdAt.toISOString() : new Date().toISOString(),
      updatedAt: schedule.updatedAt ? schedule.updatedAt.toISOString() : new Date().toISOString(),
    };
  }

  private async findOwnedAsset(buildingId: string, assetId: string) {
    const asset = await (this.prisma as any).buildingAsset.findFirst({
      where: { id: assetId, buildingId },
    });
    if (!asset) throw new NotFoundException('Asset not found');
    return asset as any;
  }

  private async findOwnedSchedule(buildingId: string, scheduleId: string) {
    const schedule = await (this.prisma as any).maintenanceSchedule.findFirst({
      where: { id: scheduleId, buildingId },
      include: { asset: true },
    });
    if (!schedule) throw new NotFoundException('Maintenance schedule not found');
    return schedule as any;
  }

  private async assertExpenseCategory(buildingId: string, categoryId: string) {
    const cat = await (this.prisma as any).expenseCategory.findFirst({
      where: { id: categoryId, buildingId },
    });
    if (!cat) throw new NotFoundException('Expense category not found');
  }
}

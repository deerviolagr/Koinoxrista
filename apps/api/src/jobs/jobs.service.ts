import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, Role } from '@prisma/client';
import type { BidStatus, JobSource, JobStatus, WorkLogView } from '@org/shared';

type JobSourceLike = JobSource | 'MAINTENANCE_SCHEDULE';

import type { AuthenticatedUser } from '../auth/auth.types';
import {
  assertSameBuilding,
  effectiveBuildingRole,
  isAdminLikeRole,
  membershipUserIds,
} from '../common/tenant';
import { CommissionsService } from '../marketplace/commission.service';
import { NotificationsService } from '../notifications/notifications.service';
import { PrismaService } from '../prisma/prisma.service';
import { CreateBidDto } from './dto/create-bid.dto';
import { CreateDefectDto } from './dto/create-defect.dto';
import { CreateJobDto } from './dto/create-job.dto';
import { CreateWorkLogDto } from './dto/create-work-log.dto';
import { RateBidDto } from './dto/rate-bid.dto';
import { UpsertProviderProfileDto } from './dto/provider-profile.dto';

export interface BidView {
  id: string;
  jobId: string;
  /** Stable identity used by provider clients to find their own bid. */
  providerUserId: string;
  amountCents: number;
  message: string | null;
  status: BidStatus;
  ratingStars: number | null;
  providerName: string;
  providerTrade: string | null;
}

export interface JobAdminView {
  id: string;
  buildingId: string;
  title: string;
  description: string;
  status: JobStatus;
  source: JobSourceLike;
  reporterName: string | null;
  budgetCents: number | null;
  workLogsCount: number;
  bidsCount: number;
  bids?: BidView[];
}

export interface JobMarketView {
  id: string;
  buildingId: string;
  buildingName: string;
  title: string;
  description: string;
  status: JobStatus;
  budgetCents: number | null;
  /** Stable array shape; marketplace contains the caller's own bids. */
  bids: BidView[];
}

export interface JobBidListView extends JobMarketView {
  /** Compatibility fields for older provider clients. */
  job: {
    id: string;
    buildingId?: string;
    title: string;
    status: JobStatus;
    buildingName: string;
  };
  bid: BidView;
}

interface BidLike {
  id: string;
  jobId: string;
  amountCents: number;
  message: string | null;
  status: string;
  ratingStars: number | null;
  providerUserId: string;
  provider: {
    firstName: string;
    lastName: string;
    profile?: { trade: string } | null;
  };
}

const BID_WITH_PROVIDER = {
  provider: {
    select: {
      firstName: true,
      lastName: true,
      profile: { select: { trade: true } },
    },
  },
} satisfies Prisma.BidInclude;

function toBidView(bid: BidLike): BidView {
  return {
    id: bid.id,
    jobId: bid.jobId,
    providerUserId: bid.providerUserId ?? '',
    amountCents: bid.amountCents,
    message: bid.message,
    status: bid.status as BidStatus,
    ratingStars: bid.ratingStars,
    providerName: [bid.provider.firstName, bid.provider.lastName]
      .filter(Boolean)
      .join(' '),
    providerTrade: bid.provider.profile?.trade ?? null,
  };
}

interface JobRowLike {
  id: string;
  buildingId: string;
  title: string;
  description: string;
  status: string;
  budgetCents: number | null;
  source?: string | null;
  reportedBy?: { firstName: string; lastName: string } | null;
  _count?: { workLogs: number; bids: number };
}

function reporterFullName(row: JobRowLike): string | null {
  if (!row.reportedBy) return null;
  return (
    [row.reportedBy.firstName, row.reportedBy.lastName]
      .filter(Boolean)
      .join(' ') || null
  );
}

function toJobAdminView(
  job: JobRowLike & { _count?: { workLogs: number; bids: number } },
): Omit<JobAdminView, 'bids'> {
  return {
    id: job.id,
    buildingId: job.buildingId,
    title: job.title,
    description: job.description,
    status: job.status as JobStatus,
    source: (job.source ?? 'ADMIN_RFP') as JobSourceLike,
    reporterName: reporterFullName(job),
    budgetCents: job.budgetCents,
    workLogsCount: job._count?.workLogs ?? 0,
    bidsCount: job._count?.bids ?? 0,
  };
}

@Injectable()
export class JobsService {
  /** Serialize same-provider submissions in this process; the DB unique key is still required across replicas. */
  private readonly bidQueues = new Map<string, Promise<unknown>>();
  private readonly knownBidKeys = new Set<string>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
    private readonly commissions: CommissionsService,
  ) {}

  async createJob(
    buildingId: string,
    dto: CreateJobDto,
    user: AuthenticatedUser,
  ): Promise<JobAdminView> {
    assertSameBuilding(user, buildingId);
    await this.requireAdminForBuilding(buildingId, user);

    const building = await this.prisma.building.findUnique({
      where: { id: buildingId },
    });
    if (!building) throw new NotFoundException('Building not found');

    const job = await this.prisma.job.create({
      data: {
        buildingId,
        title: dto.title,
        description: dto.description,
        budgetCents: dto.budgetCents,
      },
    });

    return { ...toJobAdminView(job), bids: [] };
  }

  async createDefect(
    buildingId: string,
    dto: CreateDefectDto,
    user: AuthenticatedUser,
  ): Promise<JobAdminView> {
    assertSameBuilding(user, buildingId);
    const effectiveRole = await this.effectiveRoleForBuilding(buildingId, user);
    if (
      effectiveRole !== Role.RESIDENT &&
      !isAdminLikeRole(effectiveRole)
    ) {
      throw new ForbiddenException(
        'Only residents or admins can report defects',
      );
    }

    const job = await this.prisma.job.create({
      data: {
        buildingId,
        title: dto.title,
        description: dto.description,
        status: 'OPEN',
        source: 'RESIDENT_REPORT',
        reportedById: user.id,
      },
    });

    return { ...toJobAdminView(job), bids: [] };
  }

  async listForBuilding(
    buildingId: string,
    user: AuthenticatedUser,
  ): Promise<JobAdminView[]> {
    assertSameBuilding(user, buildingId);
    const isAdmin = await this.isAdminForBuilding(buildingId, user);

    const jobs = await this.prisma.job.findMany({
      where: {
        buildingId,
        ...(isAdmin
          ? {}
          : {
              OR: [
                { source: 'ADMIN_RFP' },
                { source: 'RESIDENT_REPORT', reportedById: user.id },
              ],
            }),
      },
      include: {
        _count: { select: { workLogs: true, bids: true } },
        bids: { include: BID_WITH_PROVIDER },
        ...(isAdmin
          ? { reportedBy: { select: { firstName: true, lastName: true } } }
          : {}),
      },
      orderBy: { id: 'desc' },
    });

    return jobs.map((job) => ({
      ...toJobAdminView(job),
      ...(isAdmin ? { bids: job.bids.map(toBidView) } : {}),
    }));
  }

  async marketplace(userId?: string): Promise<JobMarketView[]> {
    const jobs = await this.prisma.job.findMany({
      where: {
        status: 'OPEN',
        // Maintenance work is operational, not a public provider offer.
        source: { notIn: ['RESIDENT_REPORT', 'MAINTENANCE_SCHEDULE'] },
      },
      include: {
        building: { select: { name: true } },
        // Returning the caller's bids makes the provider marketplace response
        // stable and lets the portal render an existing offer without a
        // second, differently shaped request.
        bids: {
          where: { providerUserId: userId ?? '__anonymous__' },
          include: BID_WITH_PROVIDER,
        },
      },
      orderBy: { id: 'desc' },
    });

    return jobs
      .filter((job) => job.source !== 'MAINTENANCE_SCHEDULE')
      .map((job) => ({
      id: job.id,
      buildingId: job.buildingId,
      buildingName: job.building.name,
      title: job.title,
      description: job.description,
      status: job.status as JobStatus,
      budgetCents: job.budgetCents,
      bids: (job.bids ?? []).map(toBidView),
    }));
  }

  async myBids(userId: string): Promise<JobBidListView[]> {
    const bids = await this.prisma.bid.findMany({
      where: { providerUserId: userId },
      include: {
        ...BID_WITH_PROVIDER,
        job: { include: { building: { select: { name: true } } } },
      },
      orderBy: { id: 'desc' },
    });

    return bids.map((bid) => {
      const bidView = toBidView(bid);
      const job = {
        id: bid.job.id,
        buildingId: bid.job.buildingId,
        title: bid.job.title,
        status: bid.job.status as JobStatus,
        buildingName: bid.job.building.name,
      };
      return {
        id: bid.job.id,
        buildingId: bid.job.buildingId,
        buildingName: job.buildingName,
        title: bid.job.title,
        description: bid.job.description,
        status: job.status,
        budgetCents: bid.job.budgetCents,
        bids: [bidView],
        // Keep the old nested fields while clients migrate to the stable job
        // row shape used by the marketplace endpoint.
        job,
        bid: bidView,
      };
    });
  }

  async createBid(
    jobId: string,
    dto: CreateBidDto,
    user: AuthenticatedUser,
  ): Promise<BidView> {
    const job = await this.prisma.job.findUnique({ where: { id: jobId } });
    if (!job) throw new NotFoundException('Job not found');
    if (job.status !== 'OPEN') {
      throw new BadRequestException('Job is not open for bids');
    }

    const bidKey = `${jobId}:${user.id}`;
    const saved = await this.withBidLock(bidKey, async () => {
      const existing = await this.prisma.bid.findFirst({
        where: { jobId, providerUserId: user.id },
      });
      if (!existing && this.knownBidKeys.has(bidKey)) {
        throw new ConflictException('A bid for this job already exists');
      }

      const result = existing
        ? await this.prisma.bid.update({
            where: { id: existing.id },
            data: {
              amountCents: dto.amountCents,
              message: dto.message ?? null,
              status: 'SUBMITTED',
            },
            include: BID_WITH_PROVIDER,
          })
        : await this.prisma.bid.create({
            data: {
              jobId,
              providerUserId: user.id,
              amountCents: dto.amountCents,
              message: dto.message,
              status: 'SUBMITTED',
            },
            include: BID_WITH_PROVIDER,
          });
      this.knownBidKeys.add(bidKey);
      return result;
    });

    try {
      await this.notifyBuildingAdmins(job.buildingId, {
        type: 'bid.received',
        title: 'Νέα προσφορά για εργασία',
        body: job.title,
        linkPath: '/jobs',
      });
    } catch {
      // Notifications are best-effort and must not roll back a bid.
    }

    return toBidView(saved);
  }

  private async notifyBuildingAdmins(
    buildingId: string,
    notification: {
      type: string;
      title: string;
      body?: string;
      linkPath?: string;
    },
  ): Promise<void> {
    const db = this.prisma as unknown as {
      membership?: unknown;
      user?: unknown;
    };
    // The real client uses Membership.  Keep the User fallback for legacy
    // rows and small test doubles.
    const recipients = db.membership
      ? await membershipUserIds(this.prisma, buildingId, [
          Role.BUILDING_OWNER,
          Role.ADMIN,
        ])
      : await this.prisma.user.findMany({
          where: { role: Role.ADMIN, buildingId },
          select: { id: true },
        }).then((rows) => rows.map((row) => row.id));
    if (recipients.length > 0) {
      await this.notifications.createForUsers(recipients, notification);
    }
  }

  async listBids(jobId: string, user: AuthenticatedUser): Promise<BidView[]> {
    const job = await this.prisma.job.findUnique({ where: { id: jobId } });
    if (!job) throw new NotFoundException('Job not found');
    assertSameBuilding(user, job.buildingId);
    await this.requireAdminForBuilding(job.buildingId, user);

    const bids = await this.prisma.bid.findMany({
      where: { jobId },
      include: BID_WITH_PROVIDER,
      orderBy: { amountCents: 'asc' },
    });

    return bids.map(toBidView);
  }

  async acceptBid(bidId: string, user: AuthenticatedUser): Promise<BidView> {
    const { view, providerUserId, award } = await this.prisma.$transaction(
      async (tx) => {
        const bid = await tx.bid.findUnique({
          where: { id: bidId },
          include: { job: true },
        });
        if (!bid) throw new NotFoundException('Bid not found');
        assertSameBuilding(user, bid.job.buildingId);
        await this.requireAdminForBuilding(bid.job.buildingId, user);
        if (bid.status !== 'SUBMITTED') {
          throw new BadRequestException('Only submitted bids can be accepted');
        }
        if (bid.job.status !== 'OPEN') {
          throw new BadRequestException('Job is not open for awarding');
        }
        const acceptedReader = tx.bid as typeof tx.bid & {
          findFirst?: (args: unknown) => Promise<{ id: string } | null>;
        };
        const alreadyAccepted = acceptedReader.findFirst
          ? await acceptedReader.findFirst({
              where: { jobId: bid.jobId, status: 'ACCEPTED' },
              select: { id: true },
            })
          : null;
        if (alreadyAccepted) {
          throw new ConflictException('This job already has an accepted bid');
        }

        // Claim the OPEN job before changing any bid.  The conditional write
        // is the serialization point: two concurrent award requests cannot
        // both leave an ACCEPTED bid behind.
        const jobClient = tx.job as typeof tx.job & {
          updateMany?: (args: unknown) => Promise<{ count: number }>;
        };
        if (typeof jobClient.updateMany === 'function') {
          const claimed = await jobClient.updateMany({
            where: { id: bid.jobId, status: 'OPEN' },
            data: { status: 'AWARDED' },
          });
          if (claimed.count !== 1) {
            throw new ConflictException('Job was already awarded');
          }
        } else {
          // Compatibility for small transaction doubles.
          await tx.job.update({
            where: { id: bid.jobId },
            data: { status: 'AWARDED' },
          });
        }

        await tx.bid.updateMany({
          where: { jobId: bid.jobId, id: { not: bidId }, status: 'SUBMITTED' },
          data: { status: 'REJECTED' },
        });
        const accepted = await tx.bid.update({
          where: { id: bidId },
          data: { status: 'ACCEPTED' },
          include: BID_WITH_PROVIDER,
        });

        return {
          view: toBidView(accepted),
          providerUserId: accepted.providerUserId,
          award: {
            buildingId: bid.job.buildingId,
            jobId: bid.jobId,
            baseCents: accepted.amountCents,
          },
        };
      },
    );

    void this.notifications.create({
      userId: providerUserId,
      type: 'bid.accepted',
      title: 'Η προσφορά σας έγινε αποδεκτή',
      linkPath: '/jobs',
    });

    // Marketplace monetization: persist the platform commission for the
    // awarded job AFTER the award commits. Failures are logged, never fatal —
    // the award must not roll back because billing bookkeeping failed.
    void this.commissions
      .createForAward({
        buildingId: award.buildingId,
        jobId: award.jobId,
        providerId: providerUserId,
        baseCents: award.baseCents,
      })
      .catch((error: unknown) => {
        console.warn(
          '[marketplace] commission creation failed after award:',
          error,
        );
      });

    return view;
  }

  async rejectBid(bidId: string, user: AuthenticatedUser): Promise<BidView> {
    const bid = await this.prisma.bid.findUnique({
      where: { id: bidId },
      include: { job: true },
    });
    if (!bid) throw new NotFoundException('Bid not found');
    assertSameBuilding(user, bid.job.buildingId);
    await this.requireAdminForBuilding(bid.job.buildingId, user);
    if (bid.job.status !== 'OPEN') {
      throw new BadRequestException('Job is not open for bid changes');
    }
    if (bid.status !== 'SUBMITTED') {
      throw new BadRequestException('Only submitted bids can be rejected');
    }

    const updated = await this.prisma.bid.update({
      where: { id: bidId },
      data: { status: 'REJECTED' },
      include: BID_WITH_PROVIDER,
    });

    return toBidView(updated);
  }

  async addWorkLog(
    jobId: string,
    dto: CreateWorkLogDto,
    user: AuthenticatedUser,
  ): Promise<WorkLogView> {
    const job = await this.prisma.job.findUnique({ where: { id: jobId } });
    if (!job) throw new NotFoundException('Job not found');

    const awarded = await this.prisma.bid.findFirst({
      where: { jobId, providerUserId: user.id, status: 'ACCEPTED' },
    });
    if (!awarded) {
      throw new ForbiddenException(
        'Only the awarded provider can log work on this job',
      );
    }
    if (job.status !== 'AWARDED' && job.status !== 'IN_PROGRESS') {
      throw new BadRequestException(
        `Work logs are not allowed for ${job.status} jobs`,
      );
    }

    const log = await this.prisma.$transaction(async (tx) => {
      const created = await tx.workLog.create({
        data: { jobId, providerUserId: user.id, note: dto.note },
      });
      if (job.status === 'AWARDED') {
        await tx.job.update({
          where: { id: jobId },
          data: { status: 'IN_PROGRESS' },
        });
      }
      return created;
    });

    try {
      await this.notifyBuildingAdmins(job.buildingId, {
        type: 'worklog.added',
        title: 'Νέο ημερολόγιο εργασίας',
        body: job.title,
        linkPath: '/jobs',
      });
    } catch {
      // Notifications are best-effort and must not roll back a work log.
    }

    return {
      id: log.id,
      jobId: log.jobId,
      note: log.note,
      loggedAt: log.loggedAt.toISOString(),
    };
  }

  async listWorkLogs(
    jobId: string,
    user: AuthenticatedUser,
  ): Promise<WorkLogView[]> {
    const job = await this.prisma.job.findUnique({ where: { id: jobId } });
    if (!job) throw new NotFoundException('Job not found');

    const effectiveRole = await this.effectiveRoleForBuilding(job.buildingId, user);
    if (effectiveRole === Role.PROVIDER) {
      const awarded = await this.prisma.bid.findFirst({
        where: { jobId, providerUserId: user.id, status: 'ACCEPTED' },
      });
      if (!awarded) {
        throw new ForbiddenException(
          'Only the awarded provider or building members can view work logs',
        );
      }
    } else {
      assertSameBuilding(user, job.buildingId);
    }

    const logs = await this.prisma.workLog.findMany({
      where: { jobId },
      orderBy: { loggedAt: 'desc' },
    });

    return logs.map((log) => ({
      id: log.id,
      jobId: log.jobId,
      note: log.note,
      loggedAt: log.loggedAt.toISOString(),
    }));
  }

  async completeJob(
    jobId: string,
    user: AuthenticatedUser,
  ): Promise<JobAdminView> {
    const job = await this.prisma.job.findUnique({ where: { id: jobId } });
    if (!job) throw new NotFoundException('Job not found');
    assertSameBuilding(user, job.buildingId);
    await this.requireAdminForBuilding(job.buildingId, user);
    if (job.status !== 'AWARDED' && job.status !== 'IN_PROGRESS') {
      throw new BadRequestException(
        'Only awarded or in-progress jobs can be completed',
      );
    }

    const updated = await this.prisma.job.update({
      where: { id: jobId },
      data: { status: 'COMPLETED' },
      include: {
        _count: { select: { workLogs: true, bids: true } },
        reportedBy: { select: { firstName: true, lastName: true } },
      },
    });

    return toJobAdminView(updated);
  }

  async convertToRfp(
    jobId: string,
    user: AuthenticatedUser,
  ): Promise<JobAdminView> {
    const job = await this.prisma.job.findUnique({ where: { id: jobId } });
    if (!job) throw new NotFoundException('Job not found');
    assertSameBuilding(user, job.buildingId);
    await this.requireAdminForBuilding(job.buildingId, user);

    const updated = await this.prisma.job.update({
      where: { id: jobId },
      data: job.source === 'RESIDENT_REPORT' ? { source: 'ADMIN_RFP' } : {},
      include: {
        _count: { select: { workLogs: true, bids: true } },
        reportedBy: { select: { firstName: true, lastName: true } },
      },
    });

    return toJobAdminView(updated);
  }

  async rateAcceptedBid(
    jobId: string,
    dto: RateBidDto,
    user: AuthenticatedUser,
  ): Promise<{ bid: BidView; providerRating: number | null }> {
    const job = await this.prisma.job.findUnique({ where: { id: jobId } });
    if (!job) throw new NotFoundException('Job not found');
    assertSameBuilding(user, job.buildingId);
    await this.requireAdminForBuilding(job.buildingId, user);

    return this.prisma.$transaction(async (tx) => {
      const accepted = await tx.bid.findFirst({
        where: { jobId, status: 'ACCEPTED' },
        include: BID_WITH_PROVIDER,
      });
      if (!accepted) {
        throw new NotFoundException('No accepted bid to rate for this job');
      }

      const rated = await tx.bid.update({
        where: { id: accepted.id },
        data: { ratingStars: dto.stars },
        include: BID_WITH_PROVIDER,
      });

      const ratedBids = await tx.bid.findMany({
        where: {
          providerUserId: rated.providerUserId,
          ratingStars: { not: null },
        },
        select: { ratingStars: true },
      });
      const sum = ratedBids.reduce((acc, b) => acc + (b.ratingStars ?? 0), 0);
      const average =
        ratedBids.length > 0
          ? Math.round((sum / ratedBids.length) * 100) / 100
          : null;

      await tx.providerProfile.upsert({
        where: { userId: rated.providerUserId },
        update: { rating: average },
        create: {
          userId: rated.providerUserId,
          trade: '',
          certs: [],
          rating: average,
        },
      });

      return { bid: toBidView(rated), providerRating: average };
    });
  }

  private async withBidLock<T>(key: string, action: () => Promise<T>): Promise<T> {
    const previous = this.bidQueues.get(key) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(action);
    this.bidQueues.set(key, current);
    try {
      return await current;
    } finally {
      if (this.bidQueues.get(key) === current) this.bidQueues.delete(key);
    }
  }

  private async effectiveRoleForBuilding(
    buildingId: string,
    user: AuthenticatedUser,
  ): Promise<Role> {
    return (await effectiveBuildingRole(this.prisma, user, buildingId)) ?? user.role;
  }

  private async isAdminForBuilding(
    buildingId: string,
    user: AuthenticatedUser,
  ): Promise<boolean> {
    return isAdminLikeRole(await this.effectiveRoleForBuilding(buildingId, user));
  }

  private async requireAdminForBuilding(
    buildingId: string,
    user: AuthenticatedUser,
  ): Promise<void> {
    if (!(await this.isAdminForBuilding(buildingId, user))) {
      throw new ForbiddenException('Building administrator access is required');
    }
  }

  async getProviderProfile(userId: string) {
    const row = await this.prisma.providerProfile.findUnique({ where: { userId } });
    return row ? this.toProviderProfile(row) : null;
  }

  async upsertProviderProfile(userId: string, dto: UpsertProviderProfileDto) {
    const profileData = {
      trade: dto.trade,
      certs: dto.certs,
      ...(dto.city !== undefined ? { city: dto.city } : {}),
      ...(dto.bio !== undefined ? { bio: dto.bio } : {}),
      ...(dto.hourlyRateCents !== undefined
        ? { hourlyRateCents: dto.hourlyRateCents }
        : {}),
    };
    const row = await this.prisma.providerProfile.upsert({
      where: { userId },
      update: profileData,
      create: { userId, ...profileData },
    });
    return this.toProviderProfile(row);
  }

  private toProviderProfile(row: {
    id?: string;
    userId: string;
    trade: string;
    certs: string[];
    rating: number | null;
    city?: string | null;
    bio?: string | null;
    hourlyRateCents?: number | null;
  }) {
    return {
      ...row,
      city: row.city ?? null,
      bio: row.bio ?? null,
      hourlyRateCents: row.hourlyRateCents ?? null,
      // Aliases used by the provider portal; retain `rating` for older
      // clients so the response remains backwards compatible.
      ratingStars: row.rating,
      ratingCount: null,
    };
  }
}

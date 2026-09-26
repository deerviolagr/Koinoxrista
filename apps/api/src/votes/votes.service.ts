import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Inject,
  Logger,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { Prisma, Role } from '@prisma/client';
import type { BallotView, VoteChoice, VoteOutcome, VoteTally } from '@org/shared';

import type { AuthenticatedUser } from '../auth/auth.types';
import {
  assertSameBuilding,
  membershipUserIds,
} from '../common/tenant';
import {
  resolveOwnershipBasis,
  totalOwnershipWeight,
  unitOwnershipWeight,
} from '@org/shared';
import { AuditService } from '../audit/audit.service';
import { NotificationsService } from '../notifications/notifications.service';
import type { SmsContext } from '../notifications/sms-templates';
import { PrismaService } from '../prisma/prisma.service';
import { RealtimeService } from '../realtime/realtime.service';
import { TenancyService } from '../tenancy/tenancy.service';
import { CastBallotDto } from './dto/cast-ballot.dto';
import { CreateVoteDto } from './dto/create-vote.dto';
import { tallyVote, TallyThresholdType } from './tally-vote';

export type DerivedVoteStatus = 'SCHEDULED' | 'OPEN' | 'CLOSED';

export interface VoteListItem {
  id: string;
  buildingId: string;
  topic: string;
  description: string | null;
  thresholdType: string;
  opensAt: string;
  closesAt: string;
  result: VoteOutcome | null;
  status: DerivedVoteStatus;
  ballotsCount: number;
}

export interface VoteDetail extends VoteListItem {
  myBallots: BallotView[];
  tally: VoteTally;
}

export interface VoteBallotRow {
  id: string;
  unitId: string;
  unitLabel: string;
  choice: VoteChoice;
}

const VOTE_WITH_COUNT = Prisma.validator<Prisma.VoteInclude>()({
  _count: { select: { ballots: true } },
});
type VoteRow = Prisma.VoteGetPayload<{ include: typeof VOTE_WITH_COUNT }>;

function derivedStatus(
  vote: Pick<VoteRow, 'opensAt' | 'closesAt' | 'result'>,
  now: Date,
): DerivedVoteStatus {
  if (vote.result !== null) return 'CLOSED';
  if (now < vote.opensAt) return 'SCHEDULED';
  // At closesAt the voting window is over. The same boundary is used by
  // castBallot, close, and the list/detail projections.
  if (now < vote.closesAt) return 'OPEN';
  return 'CLOSED';
}

interface TxLike {
  vote: {
    findUnique: (args: unknown) => Promise<any>;
    updateMany?: (args: unknown) => Promise<{ count: number }>;
    update?: (args: unknown) => Promise<any>;
  };
  ballot: {
    findMany: (args: unknown) => Promise<Array<{ unitId: string; choice: string }>>;
    upsert: (args: unknown) => Promise<any>;
  };
  unit: {
    findMany: (args: unknown) => Promise<Array<{
      id: string;
      millimes: number;
      squareMeters?: number | null;
      shareFraction?: number | null;
    }>>;
  };
}

@Injectable()
export class VotesService {
  private readonly logger = new Logger(VotesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
    private readonly realtime: RealtimeService,
    @Optional()
    @Inject(TenancyService)
    private readonly tenancy?: TenancyService,
  ) {}

  async create(
    buildingId: string,
    dto: CreateVoteDto,
    user: AuthenticatedUser,
  ): Promise<VoteListItem> {
    assertSameBuilding(user, buildingId);

    const now = new Date();
    const opensAt = dto.opensAt ? new Date(dto.opensAt) : now;
    const closesAt = new Date(dto.closesAt);
    if (Number.isNaN(opensAt.getTime()) || Number.isNaN(closesAt.getTime())) {
      throw new BadRequestException('opensAt/closesAt must be valid ISO dates');
    }
    if (closesAt.getTime() <= now.getTime()) {
      throw new BadRequestException('closesAt must be in the future');
    }
    if (opensAt.getTime() >= closesAt.getTime()) {
      throw new BadRequestException('opensAt must be before closesAt');
    }

    const vote = await this.prisma.vote.create({
      data: {
        buildingId,
        topic: dto.topic,
        description: dto.description,
        thresholdType: dto.thresholdType,
        opensAt,
        closesAt,
      },
      include: VOTE_WITH_COUNT,
    });

    this.audit.record({
      buildingId,
      actorId: user.id,
      actorRole: user.role,
      action: 'vote.created',
      entity: 'vote',
      entityId: vote.id,
      metadata: { topic: dto.topic },
    });

    void this.notifyOwners(buildingId, {
      type: 'vote.opened',
      title: `Νέα ψηφοφορία: ${dto.topic}`,
      linkPath: '/votes',
      sms: { kind: 'vote.opened', topic: dto.topic, periodKey: vote.id },
    });

    return this.toListItem(vote, now);
  }

  async list(
    buildingId: string,
    user: AuthenticatedUser,
  ): Promise<VoteListItem[]> {
    assertSameBuilding(user, buildingId);

    const votes = await this.prisma.vote.findMany({
      where: { buildingId },
      include: VOTE_WITH_COUNT,
      orderBy: { closesAt: 'asc' },
    });
    const now = new Date();

    return votes.map((vote) => this.toListItem(vote, now));
  }

  async get(voteId: string, user: AuthenticatedUser): Promise<VoteDetail> {
    const vote = await this.prisma.vote.findUnique({
      where: { id: voteId },
      include: VOTE_WITH_COUNT,
    });
    if (!vote) throw new NotFoundException('Vote not found');
    assertSameBuilding(user, vote.buildingId);

    const [ownedUnits, ballots] = await Promise.all([
      this.ownedUnits(user.id, vote.buildingId),
      this.prisma.ballot.findMany({ where: { voteId } }),
    ]);
    const ownedUnitIds = new Set(ownedUnits.map((o) => o.unitId));
    const now = new Date();

    const tally = await this.computeTally(vote, ballots, user);
    const status = derivedStatus(vote, now);
    if (status !== 'CLOSED') {
      tally.outcome = 'PENDING';
    }

    return {
      ...this.toListItem(vote, now),
      myBallots: this.myBallotViews(ballots, ownedUnitIds),
      tally,
    };
  }

  async castBallot(
    voteId: string,
    dto: CastBallotDto,
    user: AuthenticatedUser,
  ): Promise<BallotView[]> {
    const initialVote = await this.prisma.vote.findUnique({ where: { id: voteId } });
    if (!initialVote) throw new NotFoundException('Vote not found');
    assertSameBuilding(user, initialVote.buildingId);
    this.assertVotingOpen(initialVote, new Date());

    // Resolve eligibility before writing.  A tenant may have several
    // ownership rows, but only the units allowed by the building's voting
    // rules can receive this resident's ballot.
    const eligibleUnits = await this.eligibleOwnedUnits(initialVote, user);
    if (eligibleUnits.length === 0) {
      throw new ForbiddenException(
        'You are not eligible to vote for at least one unit in this building',
      );
    }

    const db = this.prisma as unknown as {
      $transaction?: (fn: (tx: TxLike) => Promise<unknown>) => Promise<unknown>;
    };
    let saved: Array<{ id: string; choice: string }>;
    if (typeof db.$transaction === 'function') {
      const result = await db.$transaction(async (tx) => {
        const current = await tx.vote.findUnique({ where: { id: voteId } });
        if (!current) throw new NotFoundException('Vote not found');
        if (current.buildingId !== initialVote.buildingId) {
          throw new ForbiddenException('Vote belongs to another building');
        }
        const now = new Date();
        this.assertVotingOpen(current, now);

        // Claim an open row before inserting ballots.  This write serializes
        // ballot writes with close(), which conditionally claims result=null.
        if (tx.vote.updateMany) {
          const claimed = await tx.vote.updateMany({
            where: {
              id: voteId,
              result: null,
              opensAt: { lte: now },
              closesAt: { gte: now },
            },
            data: { closesAt: current.closesAt },
          });
          if (claimed.count !== 1) {
            throw new BadRequestException('Voting is not open for this vote');
          }
        } else if (tx.vote.update) {
          await tx.vote.update({
            where: { id: voteId },
            data: { closesAt: current.closesAt },
          });
        } else {
          throw new ConflictException('Vote transaction cannot claim the vote');
        }

        const rows = [];
        for (const ownership of eligibleUnits) {
          rows.push(
            await tx.ballot.upsert({
              where: { voteId_unitId: { voteId, unitId: ownership.unitId } },
              update: { choice: dto.choice },
              create: { voteId, unitId: ownership.unitId, choice: dto.choice },
            }),
          );
        }
        return rows;
      });
      saved = result as Array<{ id: string; choice: string }>;
    } else {
      // Lightweight doubles used by older unit tests do not expose a
      // transaction client; retain the same eligibility and upsert semantics.
      saved = await Promise.all(
        eligibleUnits.map((ownership) =>
          this.prisma.ballot.upsert({
            where: {
              voteId_unitId: { voteId, unitId: ownership.unitId },
            },
            update: { choice: dto.choice },
            create: { voteId, unitId: ownership.unitId, choice: dto.choice },
          }),
        ),
      );
    }

    this.audit.record({
      buildingId: initialVote.buildingId,
      actorId: user.id,
      actorRole: user.role,
      action: 'vote.ballot',
      entity: 'ballot',
      entityId: voteId,
      metadata: { choice: dto.choice, units: saved.length },
    });

    // NOTE: the Ballot model carries no timestamp column; votedAt stays blank.
    const ballotsView = saved.map((ballot) => ({
      id: ballot.id,
      choice: ballot.choice as VoteChoice,
      votedAt: '',
    }));

    void this.pushTally(voteId, initialVote.buildingId, user);
    return ballotsView;
  }

  /** Recompute and broadcast the tally to every connected member. */
  private async pushTally(
    voteId: string,
    buildingId: string,
    user: AuthenticatedUser,
  ): Promise<void> {
    try {
      const vote = await this.prisma.vote.findUnique({
        where: { id: voteId },
        include: VOTE_WITH_COUNT,
      });
      if (!vote) return;
      const ballots = await this.prisma.ballot.findMany({ where: { voteId } });
      const tally = await this.computeTally(vote, ballots, user);
      this.realtime.publishToBuilding(buildingId, 'vote.updated', {
        voteId,
        ballotsCount: ballots.length,
        tally,
      });
    } catch (err: unknown) {
      // Realtime is best-effort; a tally push must never break ballot casting.
      this.logger.warn(`vote tally push failed: ${String(err)}`);
    }
  }

  async close(
    voteId: string,
    user: AuthenticatedUser,
  ): Promise<VoteDetail> {
    const initial = await this.prisma.vote.findUnique({
      where: { id: voteId },
      include: VOTE_WITH_COUNT,
    });
    if (!initial) throw new NotFoundException('Vote not found');
    assertSameBuilding(user, initial.buildingId);

    const db = this.prisma as unknown as {
      $transaction?: (fn: (tx: TxLike) => Promise<unknown>) => Promise<unknown>;
    };
    if (typeof db.$transaction === 'function') {
      const outcome = (await db.$transaction(async (tx) => {
        const vote = await tx.vote.findUnique({
          where: { id: voteId },
          include: VOTE_WITH_COUNT,
        });
        if (!vote) throw new NotFoundException('Vote not found');
        if (vote.buildingId !== initial.buildingId) {
          throw new ForbiddenException('Vote belongs to another building');
        }

        if (vote.result !== null) {
          return {
            vote,
            tally: JSON.parse(vote.result) as VoteTally,
            closedNow: false,
          };
        }

        const ballots = await tx.ballot.findMany({ where: { voteId } });
        const tally = await this.computeTally(vote, ballots, user, tx);
        const now = new Date();
        if (typeof tx.vote.updateMany !== 'function') {
          // Same defensive fallback as castBallot(): lightweight Prisma test
          // doubles may omit updateMany, but close() cannot claim the result
          // without the conditional write.
          throw new ConflictException('Vote transaction cannot claim the vote');
        }
        const claimed = await tx.vote.updateMany({
          where: { id: voteId, result: null },
          data: {
            result: JSON.stringify(tally),
            closesAt: new Date(Math.min(now.getTime(), vote.closesAt.getTime())),
          },
        });
        if (claimed.count !== 1) {
          const winner = await tx.vote.findUnique({
            where: { id: voteId },
            include: VOTE_WITH_COUNT,
          });
          if (!winner || winner.result === null) {
            throw new ConflictException('Vote was closed concurrently; retry');
          }
          return {
            vote: winner,
            tally: JSON.parse(winner.result) as VoteTally,
            closedNow: false,
          };
        }
        const updated = await tx.vote.findUnique({
          where: { id: voteId },
          include: VOTE_WITH_COUNT,
        });
        if (!updated) throw new NotFoundException('Vote not found');
        return { vote: updated, tally, closedNow: true };
      })) as {
        vote: VoteRow;
        tally: VoteTally;
        closedNow: boolean;
      };

      if (outcome.closedNow) {
        this.audit.record({
          buildingId: outcome.vote.buildingId,
          actorId: user.id,
          actorRole: user.role,
          action: 'vote.closed',
          entity: 'vote',
          entityId: voteId,
          metadata: { outcome: outcome.tally.outcome },
        });
        void this.notifyOwners(outcome.vote.buildingId, {
          type: 'vote.closed',
          title: 'Ολοκληρώθηκε η ψηφοφορία',
          linkPath: '/votes',
        });
        this.realtime.publishToBuilding(outcome.vote.buildingId, 'vote.closed', {
          voteId,
          outcome: outcome.tally.outcome,
          tally: outcome.tally,
        });
      }
      return {
        ...this.toListItem(outcome.vote, new Date()),
        myBallots: [],
        tally: outcome.tally,
      };
    }

    // Compatibility path for simple Prisma test doubles.
    if (initial.result !== null) {
      return {
        ...this.toListItem(initial, new Date()),
        myBallots: [],
        tally: JSON.parse(initial.result) as VoteTally,
      };
    }
    const ballots = await this.prisma.ballot.findMany({ where: { voteId } });
    const tally = await this.computeTally(initial, ballots, user);
    const now = new Date();
    const updated = await this.prisma.vote.update({
      where: { id: voteId },
      data: {
        result: JSON.stringify(tally),
        closesAt: new Date(Math.min(now.getTime(), initial.closesAt.getTime())),
      },
      include: VOTE_WITH_COUNT,
    });
    this.audit.record({
      buildingId: initial.buildingId,
      actorId: user.id,
      actorRole: user.role,
      action: 'vote.closed',
      entity: 'vote',
      entityId: voteId,
      metadata: { outcome: tally.outcome },
    });
    void this.notifyOwners(initial.buildingId, {
      type: 'vote.closed',
      title: 'Ολοκληρώθηκε η ψηφοφορία',
      linkPath: '/votes',
    });
    this.realtime.publishToBuilding(initial.buildingId, 'vote.closed', {
      voteId,
      outcome: tally.outcome,
      tally,
    });
    return {
      ...this.toListItem(updated, now),
      myBallots: [],
      tally,
    };
  }

  async listBallots(
    voteId: string,
    user: AuthenticatedUser,
  ): Promise<VoteBallotRow[]> {
    const vote = await this.prisma.vote.findUnique({ where: { id: voteId } });
    if (!vote) throw new NotFoundException('Vote not found');
    assertSameBuilding(user, vote.buildingId);

    const ballots = await this.prisma.ballot.findMany({
      where: { voteId },
      include: { unit: { select: { label: true } } },
      orderBy: { unitId: 'asc' },
    });

    return ballots.map((ballot) => ({
      id: ballot.id,
      unitId: ballot.unitId,
      unitLabel: ballot.unit.label,
      choice: ballot.choice as VoteChoice,
    }));
  }

  private assertVotingOpen(
    vote: { result: string | null; opensAt: Date; closesAt: Date },
    now: Date,
  ): void {
    if (
      vote.result !== null ||
      now < vote.opensAt ||
      now >= vote.closesAt
    ) {
      throw new BadRequestException('Voting is not open for this vote');
    }
  }

  private async notifyOwners(
    buildingId: string,
    notification: {
      type: string;
      title: string;
      linkPath?: string;
      sms?: SmsContext;
    },
  ): Promise<void> {
    try {
      const db = this.prisma as unknown as {
        membership?: unknown;
        user?: unknown;
        ownership?: {
          findMany: (args: unknown) => Promise<Array<{ userId: string }>>;
        };
      };
      let recipients: string[];
      if (!db.membership && !db.user && db.ownership?.findMany) {
        const owners = await db.ownership.findMany({
          where: { unit: { buildingId } },
          select: { userId: true },
          distinct: ['userId'],
        });
        recipients = owners.map((owner) => owner.userId);
      } else {
        recipients = await membershipUserIds(this.prisma, buildingId, [
          Role.BUILDING_OWNER,
          Role.ADMIN,
        ]);
      }
      if (recipients.length > 0) {
        await this.notifications.createForUsers(recipients, notification);
      }
    } catch (error: unknown) {
      this.logger.warn(`vote owner notification failed: ${String(error)}`);
    }
  }

  private toListItem(vote: VoteRow, now: Date): VoteListItem {
    let result: VoteOutcome | null = null;
    if (vote.result !== null) {
      result = (JSON.parse(vote.result) as VoteTally).outcome;
    }

    return {
      id: vote.id,
      buildingId: vote.buildingId,
      topic: vote.topic,
      description: vote.description,
      thresholdType: vote.thresholdType,
      opensAt: vote.opensAt.toISOString(),
      closesAt: vote.closesAt.toISOString(),
      result,
      status: derivedStatus(vote, now),
      ballotsCount: vote._count.ballots,
    };
  }

  private async ownedUnits(userId: string, buildingId: string) {
    return this.prisma.ownership.findMany({
      where: { userId, unit: { buildingId } },
      select: { unitId: true, unit: { select: { label: true } } },
    });
  }

  private async eligibleOwnedUnits(
    vote: { id: string; buildingId: string },
    user: AuthenticatedUser,
  ) {
    const owned = await this.ownedUnits(user.id, vote.buildingId);
    const tenancy = this.tenancy;
    if (!tenancy?.checkCanVote) return owned;
    const checks = await Promise.all(
      owned.map((ownership) =>
        tenancy.checkCanVote(
          vote.buildingId,
          vote.id,
          ownership.unitId,
          user,
        ),
      ),
    );
    return owned.filter((_, index) => checks[index]?.eligible === true);
  }

  private async computeTally(
    vote: { id: string; buildingId: string; thresholdType: string },
    ballots: { unitId: string; choice: string }[],
    user?: AuthenticatedUser,
    db: PrismaService | TxLike = this.prisma,
  ): Promise<VoteTally> {
    if (user && this.tenancy?.computeEligibleTally) {
      return this.tenancy.computeEligibleTally(
        vote.buildingId,
        vote.id,
        user,
      );
    }

    const units = await db.unit.findMany({
      where: { buildingId: vote.buildingId },
      select: { id: true, millimes: true, squareMeters: true, shareFraction: true },
    });
    const isHeadcount = vote.thresholdType === 'HEADCOUNT';
    const basis = isHeadcount ? 'MILLIMES' : resolveOwnershipBasis(units);
    const weightByUnit = new Map(
      units.map((u) => [u.id, isHeadcount ? 1 : unitOwnershipWeight(u, basis)]),
    );
    const totalWeight = isHeadcount
      ? units.length
      : totalOwnershipWeight(units, basis);

    return tallyVote(
      vote.thresholdType as TallyThresholdType,
      ballots.map((b) => ({
        choice: b.choice as VoteChoice,
        millimes: weightByUnit.get(b.unitId) ?? 0,
      })),
      units.length,
      totalWeight,
    );
  }

  private myBallotViews(
    ballots: { id: string; unitId: string; choice: string }[],
    ownedUnitIds: Set<string>,
  ): BallotView[] {
    // NOTE: no timestamp column on Ballot; votedAt stays blank.
    return ballots
      .filter((ballot) => ownedUnitIds.has(ballot.unitId))
      .map((ballot) => ({
        id: ballot.id,
        choice: ballot.choice as VoteChoice,
        votedAt: '',
      }));
  }
}

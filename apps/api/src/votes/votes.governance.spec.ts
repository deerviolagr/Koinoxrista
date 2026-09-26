import { Role } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service';
import { VotesService } from './votes.service';

const resident = {
  id: 'resident-1',
  email: 'resident@example.test',
  role: Role.RESIDENT,
  buildingId: 'building-1',
};

function openVote(overrides: Record<string, unknown> = {}) {
  return {
    id: 'vote-1',
    buildingId: 'building-1',
    topic: 'Repair',
    description: null,
    thresholdType: 'HEADCOUNT',
    opensAt: new Date(Date.now() - 60_000),
    closesAt: new Date(Date.now() + 60_000),
    result: null,
    _count: { ballots: 0 },
    ...overrides,
  };
}

describe('VotesService eligibility and atomic close', () => {
  it('casts only units accepted by the tenancy eligibility rules', async () => {
    const tx = {
      vote: {
        findUnique: jest.fn().mockResolvedValue(openVote()),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      ballot: {
        upsert: jest.fn().mockImplementation(async ({ where, update }) => ({
          id: `ballot-${where.voteId_unitId.unitId}`,
          choice: update.choice,
        })),
      },
    };
    const prisma = {
      vote: { findUnique: jest.fn().mockResolvedValue(openVote()) },
      ownership: {
        findMany: jest.fn().mockResolvedValue([
          { unitId: 'unit-a', unit: { label: 'A' } },
          { unitId: 'unit-b', unit: { label: 'B' } },
        ]),
      },
      ballot: { findMany: jest.fn().mockResolvedValue([]) },
      unit: { findMany: jest.fn().mockResolvedValue([]) },
      $transaction: jest.fn(async (fn: (client: typeof tx) => unknown) => fn(tx)),
    };
    const tenancy = {
      checkCanVote: jest.fn().mockImplementation(async (_b, _v, unitId) => ({
        eligible: unitId === 'unit-a',
      })),
      computeEligibleTally: jest.fn(),
    };
    const service = new VotesService(
      prisma as unknown as PrismaService,
      { record: jest.fn() } as any,
      { createForUsers: jest.fn(), create: jest.fn() } as any,
      { publishToBuilding: jest.fn() } as any,
      tenancy as any,
    );

    const views = await service.castBallot('vote-1', { choice: 'YES' }, resident);
    expect(views).toHaveLength(1);
    expect(tx.ballot.upsert).toHaveBeenCalledTimes(1);
    expect(tenancy.checkCanVote).toHaveBeenCalledTimes(2);
  });

  it('claims result=null in the close transaction and stores one tally', async () => {
    const storedTally = {
      yesCount: 1,
      noCount: 0,
      abstainCount: 0,
      yesMillimes: 1,
      noMillimes: 0,
      totalMillimes: 1,
      quorumMet: true,
      outcome: 'PASSED' as const,
    };
    const tx = {
      vote: {
        findUnique: jest
          .fn()
          .mockResolvedValueOnce(openVote())
          .mockResolvedValueOnce(
            openVote({
              result: JSON.stringify(storedTally),
              _count: { ballots: 1 },
            }),
          ),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      ballot: { findMany: jest.fn().mockResolvedValue([]) },
      unit: { findMany: jest.fn().mockResolvedValue([]) },
    };
    const prisma = {
      vote: { findUnique: jest.fn().mockResolvedValue(openVote()) },
      $transaction: jest.fn(async (fn: (client: typeof tx) => unknown) => fn(tx)),
      ballot: { findMany: jest.fn().mockResolvedValue([]) },
      unit: { findMany: jest.fn().mockResolvedValue([]) },
      ownership: { findMany: jest.fn().mockResolvedValue([]) },
      membership: { findMany: jest.fn().mockResolvedValue([]) },
    };
    const service = new VotesService(
      prisma as unknown as PrismaService,
      { record: jest.fn() } as any,
      { createForUsers: jest.fn() } as any,
      { publishToBuilding: jest.fn() } as any,
      {
        computeEligibleTally: jest.fn().mockResolvedValue(storedTally),
      } as any,
    );

    const result = await service.close('vote-1', resident);
    expect(result.tally).toEqual(storedTally);
    expect(tx.vote.updateMany).toHaveBeenCalledWith({
      where: { id: 'vote-1', result: null },
      data: expect.objectContaining({ result: JSON.stringify(storedTally) }),
    });
  });
});

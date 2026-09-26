import { ForbiddenException } from '@nestjs/common';

jest.mock('@nestjs/schedule', () => ({
  Cron: () => () => undefined,
}));
jest.mock('../audit/audit.service', () => ({ AuditService: class {} }));
jest.mock('../compliance/compliance.service', () => ({
  ComplianceService: class {},
}));
jest.mock('../invoices/invoices.service', () => ({
  InvoicesService: class {},
}));
jest.mock('../kpi/kpi.service', () => ({ KpiService: class {} }));
jest.mock('../late-fees/late-fees.service', () => ({
  LateFeesService: class {},
}));
jest.mock('../maintenance/maintenance.service', () => ({
  MaintenanceService: class {},
}));
jest.mock('../prisma/prisma.service', () => ({ PrismaService: class {} }));
jest.mock('../recurring/recurring.service', () => ({
  RecurringService: class {},
}));
jest.mock('../reminders/reminders.service', () => ({
  RemindersService: class {},
}));
jest.mock('../votes/votes.service', () => ({ VotesService: class {} }));
jest.mock('../common/tenant', () => ({
  requireValidPeriod: (value: string) => value,
}));

import type { AuthenticatedUser } from '../auth/auth.types';
import { PrismaService } from '../prisma/prisma.service';
import { SchedulerService, STALE_RUN_AFTER_MS } from './scheduler.service';

const user = (
  overrides: Partial<AuthenticatedUser> = {},
): AuthenticatedUser => ({
  id: 'admin-1',
  email: 'admin@example.test',
  role: 'ADMIN' as AuthenticatedUser['role'],
  buildingId: 'building-1',
  ...overrides,
});

function makeService() {
  const runs = new Map<string, any>();
  const key = (where: {
    buildingId: string;
    jobType: string;
    period: string;
  }) => `${where.buildingId}:${where.jobType}:${where.period}`;

  const prisma: any = {
    building: { findMany: jest.fn().mockResolvedValue([{ id: 'building-1' }]) },
    user: {
      findUnique: jest.fn().mockResolvedValue({
        id: 'admin-1',
        buildingId: 'building-1',
        role: 'ADMIN',
        status: 'ACTIVE',
      }),
      findFirst: jest.fn().mockResolvedValue({
        id: 'admin-1',
        email: 'admin@example.test',
        buildingId: 'building-1',
        role: 'ADMIN',
        status: 'ACTIVE',
      }),
    },
    jobRun: {
      findFirst: jest
        .fn()
        .mockImplementation(({ where }: any) =>
          Promise.resolve(runs.get(key(where)) ?? null),
        ),
      create: jest.fn().mockImplementation(({ data }: any) => {
        const row = {
          id: `run-${runs.size + 1}`,
          ...data,
          startedAt: new Date(),
          finishedAt: null,
        };
        runs.set(key(data), row);
        return Promise.resolve(row);
      }),
      update: jest.fn().mockImplementation(({ where, data }: any) => {
        const row = [...runs.values()].find(
          (candidate) => candidate.id === where.id,
        );
        if (!row) return Promise.reject(new Error('missing run'));
        Object.assign(row, data);
        return Promise.resolve(row);
      }),
      findMany: jest.fn().mockResolvedValue([]),
    },
    vote: { findMany: jest.fn().mockResolvedValue([]) },
  };

  const invoices = { run: jest.fn().mockResolvedValue({ ok: true }) };
  const recurring = { generate: jest.fn().mockResolvedValue({ created: 0 }) };
  const lateFees = { run: jest.fn().mockResolvedValue({ charged: 0 }) };
  const reminders = { send: jest.fn().mockResolvedValue({ sent: 1 }) };
  const maintenance = {
    generateDueJobs: jest.fn().mockResolvedValue({ created: 0 }),
  };
  const compliance = {
    checkExpiries: jest.fn().mockResolvedValue({ notified: 0 }),
  };
  const votes = { close: jest.fn().mockResolvedValue({}) };
  const kpi = {
    snapshot: jest.fn().mockResolvedValue({}),
    checkAnomalies: jest.fn().mockResolvedValue({ fired: [] }),
  };
  const audit = { record: jest.fn() };

  const service = new SchedulerService(
    prisma as PrismaService,
    audit as any,
    invoices as any,
    recurring as any,
    lateFees as any,
    reminders as any,
    maintenance as any,
    compliance as any,
    votes as any,
    kpi as any,
  );

  return {
    service,
    prisma,
    runs,
    invoices,
    recurring,
    lateFees,
    reminders,
    maintenance,
    compliance,
    votes,
    kpi,
    audit,
  };
}

describe('SchedulerService reliability', () => {
  const originalEnabled = process.env.JOB_SCHEDULER_ENABLED;

  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2027-01-15T12:00:00.000Z'));
    process.env.JOB_SCHEDULER_ENABLED = 'true';
  });

  afterEach(() => {
    jest.useRealTimers();
    if (originalEnabled === undefined) delete process.env.JOB_SCHEDULER_ENABLED;
    else process.env.JOB_SCHEDULER_ENABLED = originalEnabled;
  });

  it('uses the actual previous UTC month across the January boundary', () => {
    expect(
      SchedulerService.previousMonthKey(new Date('2027-01-01T00:00:00.000Z')),
    ).toBe('2026-12');
    expect(
      SchedulerService.previousMonthKey(new Date('2026-03-31T23:59:59.000Z')),
    ).toBe('2026-02');
  });

  it('runs daily occurrences again on the next UTC date', async () => {
    const ctx = makeService();

    await ctx.service.remindersRun();
    jest.setSystemTime(new Date('2027-01-16T12:00:00.000Z'));
    await ctx.service.remindersRun();

    expect(ctx.reminders.send).toHaveBeenCalledTimes(2);
    expect(ctx.prisma.jobRun.create).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        data: expect.objectContaining({
          jobType: 'reminders',
          period: '2027-01-15',
        }),
      }),
    );
    expect(ctx.prisma.jobRun.create).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        data: expect.objectContaining({
          jobType: 'reminders',
          period: '2027-01-16',
        }),
      }),
    );
  });

  it('retries a failed occurrence in place using the existing JobRun row', async () => {
    const ctx = makeService();
    const existing = {
      id: 'failed-run',
      buildingId: 'building-1',
      jobType: 'reminders',
      period: '2027-01-15',
      status: 'FAILED',
      message: 'temporary failure',
      startedAt: new Date('2027-01-15T11:00:00.000Z'),
      finishedAt: new Date('2027-01-15T11:00:01.000Z'),
    };
    ctx.runs.set('building-1:reminders:2027-01-15', existing);

    const result = await ctx.service.trigger('reminders', user());

    expect(result).toEqual(
      expect.objectContaining({ accepted: true, success: true, ran: 1 }),
    );
    expect(ctx.prisma.jobRun.create).not.toHaveBeenCalled();
    expect(ctx.prisma.jobRun.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'failed-run' },
        data: expect.objectContaining({ status: 'RUNNING', message: null }),
      }),
    );
    expect(ctx.reminders.send).toHaveBeenCalledWith(
      'building-1',
      undefined,
      expect.objectContaining({ id: 'admin-1' }),
    );
  });

  it('retries a stale RUNNING occurrence but leaves a fresh one alone', async () => {
    const ctx = makeService();
    const stale = {
      id: 'stale-run',
      buildingId: 'building-1',
      jobType: 'maintenance_jobs',
      period: '2027-01-15',
      status: 'RUNNING',
      startedAt: new Date(Date.now() - STALE_RUN_AFTER_MS - 1),
      finishedAt: null,
    };
    ctx.runs.set('building-1:maintenance_jobs:2027-01-15', stale);

    await ctx.service.trigger('maintenance_jobs', user());
    expect(ctx.maintenance.generateDueJobs).toHaveBeenCalledTimes(1);

    const fresh = {
      id: 'fresh-run',
      buildingId: 'building-1',
      jobType: 'compliance_check',
      period: '2027-01-15',
      status: 'RUNNING',
      startedAt: new Date(),
      finishedAt: null,
    };
    ctx.runs.set('building-1:compliance_check:2027-01-15', fresh);
    await ctx.service.trigger('compliance_check', user());
    expect(ctx.compliance.checkExpiries).not.toHaveBeenCalled();
  });

  it('scopes history to the live building and rejects a foreign building', async () => {
    const ctx = makeService();
    await ctx.service.history(user(), 999);
    expect(ctx.prisma.jobRun.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { buildingId: 'building-1' },
        take: 100,
      }),
    );

    await expect(
      ctx.service.trigger('recurring_gen', user({ buildingId: 'building-2' })),
    ).rejects.toThrow(ForbiddenException);
    await expect(ctx.service.history(user(), 10, 'building-2')).rejects.toThrow(
      ForbiddenException,
    );
    await expect(
      ctx.service.trigger('reminders', user({ status: 'DISABLED' } as any)),
    ).rejects.toThrow(ForbiddenException);
  });

  it('allows a manual trigger while cron is disabled and reports that state', async () => {
    process.env.JOB_SCHEDULER_ENABLED = 'false';
    const ctx = makeService();

    const result = await ctx.service.trigger('invoice_run', user());

    expect(result).toEqual(
      expect.objectContaining({
        accepted: true,
        cronEnabled: false,
        buildingId: 'building-1',
      }),
    );
    expect(ctx.invoices.run).toHaveBeenCalledTimes(1);

    await ctx.service.remindersRun();
    expect(ctx.reminders.send).not.toHaveBeenCalled();
  });

  it('schedules recurring generation before invoice aggregation', async () => {
    const ctx = makeService();
    await ctx.service.recurringGen();
    await ctx.service.invoiceRun();

    expect(ctx.recurring.generate).toHaveBeenCalledWith(
      'building-1',
      '2026-12',
      expect.objectContaining({ id: 'admin-1' }),
    );
    expect(ctx.invoices.run).toHaveBeenCalledWith(
      'building-1',
      { periodYearMonth: '2026-12' },
      expect.objectContaining({ id: 'admin-1' }),
    );
    expect(ctx.recurring.generate.mock.invocationCallOrder[0]).toBeLessThan(
      ctx.invoices.run.mock.invocationCallOrder[0],
    );
  });
});

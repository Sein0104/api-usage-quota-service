import { randomUUID } from 'node:crypto';
import { jest } from '@jest/globals';
import type { PrismaService } from '../database/prisma.service.js';
import { DailyUsageService } from './daily-usage.service.js';
import { UsageRepository } from './usage.repository.js';

describe('DailyUsageService', () => {
  const actor = {
    id: randomUUID(),
    projectId: randomUUID(),
    scopes: ['usage:read'] as const,
  };

  it('queries only the actor project with inclusive UTC bounds and ascending dates', async () => {
    const rows = [
      {
        limitUnits: 10n,
        updatedAt: new Date('2026-08-01T10:00:00.000Z'),
        usageDate: new Date('2026-08-01T00:00:00.000Z'),
        usedUnits: 2n,
      },
    ];
    const findMany = jest.fn(async () => rows);
    const prisma = { dailyUsage: { findMany } } as unknown as PrismaService;
    const service = new DailyUsageService(prisma, new UsageRepository());

    await expect(
      service.list(actor, '2026-08-01', '2026-08-02'),
    ).resolves.toEqual(rows);
    expect(findMany).toHaveBeenCalledWith({
      orderBy: { usageDate: 'asc' },
      select: {
        limitUnits: true,
        updatedAt: true,
        usageDate: true,
        usedUnits: true,
      },
      where: {
        projectId: actor.projectId,
        usageDate: {
          gte: new Date('2026-08-01T00:00:00.000Z'),
          lte: new Date('2026-08-02T00:00:00.000Z'),
        },
      },
    });
  });

  it('maps only database availability failures to 503', async () => {
    class FailingRepository extends UsageRepository {
      override async listDaily(): Promise<never> {
        throw { code: 'P1001' };
      }
    }
    await expect(
      new DailyUsageService({} as PrismaService, new FailingRepository()).list(
        actor,
        '2026-08-01',
        '2026-08-02',
      ),
    ).rejects.toMatchObject({
      problem: { code: 'DEPENDENCY_UNAVAILABLE', status: 503 },
    });
  });

  it.each([
    {
      code: 'P2010',
      meta: { driverAdapterError: { cause: { originalCode: '23514' } } },
    },
    new Error('ordinary defect'),
  ])(
    'preserves a non-dependency failure for the global 500 mapper',
    async (failure) => {
      class FailingRepository extends UsageRepository {
        override async listDaily(): Promise<never> {
          throw failure;
        }
      }
      await expect(
        new DailyUsageService(
          {} as PrismaService,
          new FailingRepository(),
        ).list(actor, '2026-08-01', '2026-08-02'),
      ).rejects.toBe(failure);
    },
  );
});

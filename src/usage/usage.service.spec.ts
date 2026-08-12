import { randomUUID } from 'node:crypto';
import type { PrismaService } from '../database/prisma.service.js';
import { UsageRepository } from './usage.repository.js';
import { UsageService } from './usage.service.js';

describe('UsageService database error mapping', () => {
  const actor = {
    id: randomUUID(),
    projectId: randomUUID(),
    scopes: ['usage:write'] as const,
  };
  const context = {
    receivedAt: new Date('2026-08-11T12:00:00.000Z'),
    requestId: randomUUID(),
  };

  function serviceThrowing(error: unknown): UsageService {
    return new UsageService(
      {
        $transaction: async () => {
          throw error;
        },
      } as unknown as PrismaService,
      new UsageRepository(),
    );
  }

  it('maps only a recognized database dependency failure to 503', async () => {
    await expect(
      serviceThrowing({ code: 'P1001' }).ingest(
        actor,
        { units: 1 },
        randomUUID(),
        context,
      ),
    ).rejects.toMatchObject({
      problem: { code: 'DEPENDENCY_UNAVAILABLE', status: 503 },
    });
  });

  it('preserves a raw constraint defect for the global 500 mapper', async () => {
    const constraint = {
      code: 'P2010',
      meta: {
        driverAdapterError: { cause: { originalCode: '23514' } },
      },
    };
    await expect(
      serviceThrowing(constraint).ingest(
        actor,
        { units: 1 },
        randomUUID(),
        context,
      ),
    ).rejects.toBe(constraint);
  });
});

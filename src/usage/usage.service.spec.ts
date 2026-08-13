import { randomUUID } from 'node:crypto';
import { jest } from '@jest/globals';
import { Prisma } from '../generated/prisma/client.js';
import type { PrismaService } from '../database/prisma.service.js';
import { UsageRepository } from './usage.repository.js';
import { UsageService } from './usage.service.js';
import { IdempotencyRetry } from './idempotency-retry.js';
import { quotaTime } from './domain/quota-time.js';

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

  it('opens the usage transaction with explicit READ COMMITTED isolation', async () => {
    const dependencyFailure = { code: 'P1001' };
    const transaction = jest.fn(async () => {
      throw dependencyFailure;
    });
    const service = new UsageService(
      { $transaction: transaction } as unknown as PrismaService,
      new UsageRepository(),
    );

    await expect(
      service.ingest(actor, { units: 1 }, randomUUID(), context),
    ).rejects.toMatchObject({
      problem: { code: 'DEPENDENCY_UNAVAILABLE', status: 503 },
    });
    expect(transaction).toHaveBeenCalledWith(expect.any(Function), {
      isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
    });
  });
});

describe('UsageService idempotency visibility retry', () => {
  it('retries only the conflict-insert followed by an invisible row and returns the dedicated 503 after four transactions', async () => {
    const transaction = jest.fn(async (operation: (tx: object) => unknown) =>
      operation({}),
    );
    class InvisibleConflictRepository extends UsageRepository {
      readonly inputs: Parameters<UsageRepository['insertPending']>[1][] = [];

      override async insertPending(
        _tx: Parameters<UsageRepository['insertPending']>[0],
        input: Parameters<UsageRepository['insertPending']>[1],
      ): Promise<null> {
        this.inputs.push(input);
        return null;
      }

      override async findByIdempotencyKey(): Promise<null> {
        return null;
      }
    }
    const wait = jest.fn(async () => undefined);
    const calculateQuotaTime = jest.fn(quotaTime);
    const retryContext = {
      receivedAt: new Date('2026-08-11T12:00:00.000Z'),
      requestId: randomUUID(),
    };
    const repository = new InvisibleConflictRepository();
    const service = new UsageService(
      { $transaction: transaction } as unknown as PrismaService,
      repository,
      new IdempotencyRetry({ wait }),
      calculateQuotaTime,
    );

    await expect(
      service.ingest(
        {
          id: randomUUID(),
          projectId: randomUUID(),
          scopes: ['usage:write'],
        },
        { units: 1 },
        randomUUID(),
        retryContext,
      ),
    ).rejects.toMatchObject({
      problem: { code: 'CONCURRENT_REQUEST_RETRY_EXHAUSTED', status: 503 },
    });
    expect(transaction).toHaveBeenCalledTimes(4);
    expect(calculateQuotaTime).toHaveBeenCalledTimes(1);
    expect(calculateQuotaTime).toHaveBeenCalledWith(retryContext.receivedAt);
    expect(wait.mock.calls).toEqual([[10], [10], [10]]);
    expect(repository.inputs).toHaveLength(4);
    for (const retryInput of repository.inputs.slice(1)) {
      expect(retryInput.payloadHash).toBe(repository.inputs[0].payloadHash);
      expect(retryInput.receivedAt).toBe(repository.inputs[0].receivedAt);
      expect(retryInput.usageDate).toBe(repository.inputs[0].usageDate);
      expect(retryInput.idempotencyKey).toBe(
        repository.inputs[0].idempotencyKey,
      );
      expect(retryInput.units).toBe(repository.inputs[0].units);
    }
  });
});

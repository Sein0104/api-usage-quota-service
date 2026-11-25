import { randomUUID } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { jest } from '@jest/globals';
import { Prisma } from '../generated/prisma/client.js';
import type { PrismaService } from '../database/prisma.service.js';
import { UsageRepository } from './usage.repository.js';
import { UsageService } from './usage.service.js';
import { IdempotencyRetry } from './idempotency-retry.js';
import { quotaTime } from './domain/quota-time.js';
import { MetricsService } from '../observability/metrics.service.js';

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
      new IdempotencyRetry(),
      quotaTime,
      new MetricsService(),
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
      new IdempotencyRetry(),
      quotaTime,
      new MetricsService(),
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
    const metrics = new MetricsService();
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
      metrics,
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
    expect(await metrics.exposition()).toContain(
      'db_transaction_duration_seconds_count{transaction="USAGE_INGEST"} 4',
    );
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

describe('UsageService domain metrics', () => {
  const actor = {
    id: randomUUID(),
    projectId: randomUUID(),
    scopes: ['usage:write'] as const,
  };
  const context = {
    receivedAt: new Date('2026-08-11T12:00:00.000Z'),
    requestId: randomUUID(),
  };

  it('counts only a newly committed terminal decision while timing every transaction', async () => {
    const eventId = randomUUID();
    const terminal = {
      decision: 'ACCEPTED' as const,
      eventId,
      payloadHash: Buffer.alloc(32),
      quotaLimit: 10n,
      quotaRemaining: 7n,
      quotaResetAt: new Date('2026-08-12T00:00:00.000Z'),
      responseStatus: 200 as const,
      units: 3n,
      usageDate: '2026-08-11',
    };
    const repository = {
      insertPending: jest.fn(async () => eventId),
      createDailyUsage: jest.fn(async () => undefined),
      tryConsume: jest.fn(async () => ({ limit: 10n, used: 3n })),
      lockDailyUsage: jest.fn(),
      finalize: jest.fn(async () => terminal),
    };
    const metrics = new MetricsService();
    const service = new UsageService(
      {
        $transaction: async (operation: (tx: object) => unknown) =>
          operation({}),
      } as never,
      repository as never,
      new IdempotencyRetry(),
      quotaTime,
      metrics,
    );

    await service.ingest(actor, { units: 3 }, randomUUID(), context);

    const exposition = await metrics.exposition();
    expect(exposition).toContain(
      'quota_decisions_total{decision="ACCEPTED"} 1',
    );
    expect(exposition).toContain('usage_units_accepted_total 3');
    expect(exposition).toContain(
      'db_transaction_duration_seconds_count{transaction="USAGE_INGEST"} 1',
    );
  });

  it('does not count an idempotency replay as another quota decision', async () => {
    const existing = {
      decision: 'ACCEPTED' as const,
      eventId: randomUUID(),
      payloadHash: Buffer.from(
        '064139be9753501f0345c94604e0c39490314051e6d105aa31484bf2c0ea1ee7',
        'hex',
      ),
      quotaLimit: 10n,
      quotaRemaining: 7n,
      quotaResetAt: new Date('2026-08-12T00:00:00.000Z'),
      responseStatus: 200 as const,
      units: 3n,
      usageDate: '2026-08-11',
    };
    const metrics = new MetricsService();
    const service = new UsageService(
      {
        $transaction: async (operation: (tx: object) => unknown) =>
          operation({}),
      } as never,
      {
        insertPending: jest.fn(async () => null),
        findByIdempotencyKey: jest.fn(async () => existing),
      } as never,
      new IdempotencyRetry(),
      quotaTime,
      metrics,
    );

    await service.ingest(actor, { units: 3 }, randomUUID(), context);

    const exposition = await metrics.exposition();
    expect(exposition).not.toContain('quota_decisions_total{');
    expect(exposition).toContain(
      'db_transaction_duration_seconds_count{transaction="USAGE_INGEST"} 1',
    );
  });

  it('counts a newly committed quota rejection without accepted units', async () => {
    const eventId = randomUUID();
    const metrics = new MetricsService();
    const service = new UsageService(
      {
        $transaction: async (operation: (tx: object) => unknown) =>
          operation({}),
      } as never,
      {
        insertPending: jest.fn(async () => eventId),
        createDailyUsage: jest.fn(async () => undefined),
        tryConsume: jest.fn(async () => null),
        lockDailyUsage: jest.fn(async () => ({ limit: 2n, used: 2n })),
        finalize: jest.fn(async () => ({
          decision: 'QUOTA_EXCEEDED',
          eventId,
          payloadHash: Buffer.alloc(32),
          quotaLimit: 2n,
          quotaRemaining: 0n,
          quotaResetAt: new Date('2026-08-12T00:00:00.000Z'),
          responseStatus: 429,
          units: 1n,
          usageDate: '2026-08-11',
        })),
      } as never,
      new IdempotencyRetry(),
      quotaTime,
      metrics,
    );

    await expect(
      service.ingest(actor, { units: 1 }, randomUUID(), context),
    ).resolves.toMatchObject({
      decision: 'QUOTA_EXCEEDED',
      responseStatus: 429,
    });
    const exposition = await metrics.exposition();
    expect(exposition).toContain(
      'quota_decisions_total{decision="QUOTA_EXCEEDED"} 1',
    );
    expect(exposition).toContain('usage_units_accepted_total 0');
  });

  it('does not count a conflicting replay or a rolled-back terminal decision', async () => {
    const metrics = new MetricsService();
    const conflictService = new UsageService(
      {
        $transaction: async (operation: (tx: object) => unknown) =>
          operation({}),
      } as never,
      {
        insertPending: jest.fn(async () => null),
        findByIdempotencyKey: jest.fn(async () => ({
          decision: 'ACCEPTED',
          eventId: randomUUID(),
          payloadHash: Buffer.alloc(32, 255),
          quotaLimit: 10n,
          quotaRemaining: 9n,
          quotaResetAt: new Date('2026-08-12T00:00:00.000Z'),
          responseStatus: 200,
          units: 1n,
          usageDate: '2026-08-11',
        })),
      } as never,
      new IdempotencyRetry(),
      quotaTime,
      metrics,
    );
    await expect(
      conflictService.ingest(actor, { units: 1 }, randomUUID(), context),
    ).rejects.toMatchObject({ problem: { code: 'IDEMPOTENCY_KEY_REUSED' } });

    const rollbackError = new Error('rollback canary');
    const rollbackService = new UsageService(
      {
        $transaction: async (operation: (tx: object) => unknown) => {
          await operation({});
          throw rollbackError;
        },
      } as never,
      {
        insertPending: jest.fn(async () => randomUUID()),
        createDailyUsage: jest.fn(async () => undefined),
        tryConsume: jest.fn(async () => ({ limit: 10n, used: 1n })),
        finalize: jest.fn(async () => ({
          decision: 'ACCEPTED',
          eventId: randomUUID(),
          payloadHash: Buffer.alloc(32),
          quotaLimit: 10n,
          quotaRemaining: 9n,
          quotaResetAt: new Date('2026-08-12T00:00:00.000Z'),
          responseStatus: 200,
          units: 1n,
          usageDate: '2026-08-11',
        })),
      } as never,
      new IdempotencyRetry(),
      quotaTime,
      metrics,
    );
    await expect(
      rollbackService.ingest(actor, { units: 1 }, randomUUID(), context),
    ).rejects.toBe(rollbackError);

    const exposition = await metrics.exposition();
    expect(exposition).not.toContain('quota_decisions_total{');
    expect(exposition).toContain(
      'db_transaction_duration_seconds_count{transaction="USAGE_INGEST"} 2',
    );
  });

  it('preserves committed results and original failures when metrics throw', async () => {
    const eventId = randomUUID();
    const terminalRecord = {
      decision: 'ACCEPTED' as const,
      eventId,
      payloadHash: Buffer.alloc(32),
      quotaLimit: 10n,
      quotaRemaining: 9n,
      quotaResetAt: new Date('2026-08-12T00:00:00.000Z'),
      responseStatus: 200 as const,
      units: 1n,
      usageDate: '2026-08-11',
    };
    const throwingMetrics = {
      observeTransaction: jest.fn(() => {
        throw new Error('transaction metric failed');
      }),
      recordQuotaDecision: jest.fn(() => {
        throw new Error('quota metric failed');
      }),
    } as unknown as MetricsService;
    const repository = {
      insertPending: jest.fn(async () => eventId),
      createDailyUsage: jest.fn(async () => undefined),
      tryConsume: jest.fn(async () => ({ limit: 10n, used: 1n })),
      finalize: jest.fn(async () => terminalRecord),
    };
    const committedService = new UsageService(
      {
        $transaction: async (operation: (tx: object) => unknown) =>
          operation({}),
      } as never,
      repository as never,
      new IdempotencyRetry(),
      quotaTime,
      throwingMetrics,
    );
    await expect(
      committedService.ingest(actor, { units: 1 }, randomUUID(), context),
    ).resolves.toMatchObject({ decision: 'ACCEPTED', eventId });

    const original = new Error('original transaction failure');
    const failingService = new UsageService(
      {
        $transaction: async () => {
          throw original;
        },
      } as never,
      repository as never,
      new IdempotencyRetry(),
      quotaTime,
      throwingMetrics,
    );
    await expect(
      failingService.ingest(actor, { units: 1 }, randomUUID(), context),
    ).rejects.toBe(original);
    expect(throwingMetrics.observeTransaction).toHaveBeenCalledTimes(2);
    expect(throwingMetrics.recordQuotaDecision).toHaveBeenCalledTimes(1);
  });
});

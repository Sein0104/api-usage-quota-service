import { ApiKeysService } from './api-keys.service.js';
import { jest } from '@jest/globals';
import { Buffer } from 'node:buffer';
import { ProblemException } from '../common/http/problem.exception.js';
import { CursorCodec } from '../common/pagination/cursor-codec.js';
import { MetricsService } from '../observability/metrics.service.js';

const actor = {
  id: '11111111-2222-4333-8444-555555555555',
  projectId: '22222222-2222-4333-8444-555555555555',
  scopes: ['keys:manage'] as const,
};

describe('ApiKeysService.create', () => {
  it.each([
    { name: ' whitespace ', scopes: ['usage:read'] },
    { name: 'valid', scopes: [] },
    { name: 'valid', scopes: ['usage:read', 'usage:read'] },
    { name: 'valid', scopes: ['unknown'] },
    { name: 'valid', scopes: 'usage:read' },
  ])(
    'rejects invalid direct runtime input before starting a transaction: %o',
    async (command) => {
      const transaction = jest.fn();
      const service = new ApiKeysService(
        { $transaction: transaction } as never,
        { issue: jest.fn() } as never,
        {} as never,
        {} as never,
        new CursorCodec(),
        new MetricsService(),
      );

      await expect(
        service.create(actor, command as never, {
          requestId: '33333333-2222-4333-8444-555555555555',
        }),
      ).rejects.toMatchObject<Partial<ProblemException>>({
        problem: expect.objectContaining({
          code: 'VALIDATION_ERROR',
          status: 400,
        }),
      });
      expect(transaction).not.toHaveBeenCalled();
    },
  );

  it('counts Unicode code points consistently with DTO and PostgreSQL name limits', async () => {
    const issued = {
      digest: Buffer.alloc(32),
      id: '44444444-2222-4333-8444-555555555555',
      plaintext: `mq_44444444-2222-4333-8444-555555555555.${'a'.repeat(43)}`,
      prefix: 'mq_44444444-2222-4333-8444-555555555555',
    };
    const repository = {
      countActive: jest.fn(async () => 0),
      create: jest.fn(async (_tx: unknown, command: { name: string }) => ({
        id: issued.id,
        name: command.name,
        prefix: issued.prefix,
        scopes: ['usage:read'],
      })),
      lockProject: jest.fn(async () => undefined),
    };
    const transaction = jest.fn(
      async (operation: (tx: object) => Promise<unknown>) => operation({}),
    );
    const service = new ApiKeysService(
      { $transaction: transaction } as never,
      { issue: jest.fn(() => issued) } as never,
      repository as never,
      { recordApiKeyCreated: jest.fn(async () => undefined) } as never,
      new CursorCodec(),
      new MetricsService(),
    );
    const context = { requestId: '33333333-2222-4333-8444-555555555555' };

    await expect(
      service.create(
        actor,
        { name: '😀'.repeat(100), scopes: ['usage:read'] },
        context,
      ),
    ).resolves.toMatchObject({ apiKey: { name: '😀'.repeat(100) } });
    await expect(
      service.create(
        actor,
        { name: '😀'.repeat(101), scopes: ['usage:read'] },
        context,
      ),
    ).rejects.toMatchObject<Partial<ProblemException>>({
      problem: expect.objectContaining({
        code: 'VALIDATION_ERROR',
        status: 400,
      }),
    });
    expect(transaction).toHaveBeenCalledTimes(1);
  });
});

describe('ApiKeysService transaction observability', () => {
  const context = { requestId: '33333333-2222-4333-8444-555555555555' };
  const issued = {
    digest: Buffer.alloc(32),
    id: '44444444-2222-4333-8444-555555555555',
    plaintext: `mq_44444444-2222-4333-8444-555555555555.${'a'.repeat(43)}`,
    prefix: 'mq_44444444-2222-4333-8444-555555555555',
  };

  function service(
    transaction: (
      operation: (tx: object) => Promise<unknown>,
    ) => Promise<unknown>,
    repository: Record<string, unknown>,
    metrics: MetricsService,
  ) {
    return new ApiKeysService(
      { $transaction: jest.fn(transaction) } as never,
      { issue: jest.fn(() => issued) } as never,
      repository as never,
      {
        recordApiKeyCreated: jest.fn(async () => undefined),
        recordApiKeyRevoked: jest.fn(async () => undefined),
      } as never,
      new CursorCodec(),
      metrics,
    );
  }

  it('times successful create and revoke transactions', async () => {
    const metrics = new MetricsService();
    const target = {
      createdAt: new Date(),
      id: issued.id,
      name: 'worker',
      prefix: issued.prefix,
      projectId: actor.projectId,
      revokedAt: null,
      scopes: ['usage:read'],
      secretDigest: issued.digest,
      status: 'ACTIVE',
    };
    const repository = {
      countActive: jest.fn(async () => 1),
      create: jest.fn(async () => target),
      lockForRevoke: jest.fn(async () => target),
      lockProject: jest.fn(async () => undefined),
      revoke: jest.fn(async () => undefined),
    };
    const apiKeys = service(
      async (operation) => operation({}),
      repository,
      metrics,
    );

    await expect(
      apiKeys.create(
        actor,
        { name: 'worker', scopes: ['usage:read'] },
        context,
      ),
    ).resolves.toMatchObject({ apiKey: { id: issued.id } });
    await expect(
      apiKeys.revoke(actor, issued.id, context),
    ).resolves.toBeUndefined();
    const exposition = await metrics.exposition();
    expect(exposition).toContain(
      'db_transaction_duration_seconds_count{transaction="API_KEY_CREATE"} 1',
    );
    expect(exposition).toContain(
      'db_transaction_duration_seconds_count{transaction="API_KEY_REVOKE"} 1',
    );
  });

  it.each([
    ['create', 'API_KEY_CREATE'],
    ['revoke', 'API_KEY_REVOKE'],
  ] as const)(
    'times a failed %s transaction',
    async (operation, transaction) => {
      const metrics = new MetricsService();
      const apiKeys = service(
        async () => Promise.reject({ code: 'P1001' }),
        {},
        metrics,
      );

      const result =
        operation === 'create'
          ? apiKeys.create(
              actor,
              { name: 'worker', scopes: ['usage:read'] },
              context,
            )
          : apiKeys.revoke(actor, issued.id, context);
      await expect(result).rejects.toMatchObject({
        problem: { code: 'DEPENDENCY_UNAVAILABLE' },
      });
      expect(await metrics.exposition()).toContain(
        `db_transaction_duration_seconds_count{transaction="${transaction}"} 1`,
      );
    },
  );

  it('does not alter create or revoke outcomes when metrics throw', async () => {
    const target = {
      id: issued.id,
      name: 'worker',
      prefix: issued.prefix,
      scopes: ['usage:read'],
      status: 'ACTIVE',
    };
    const throwingMetrics = {
      observeTransaction: jest.fn(() => {
        throw new Error('metric canary');
      }),
    } as unknown as MetricsService;
    const apiKeys = service(
      async (operation) => operation({}),
      {
        countActive: jest.fn(async () => 1),
        create: jest.fn(async () => target),
        lockForRevoke: jest.fn(async () => target),
        lockProject: jest.fn(async () => undefined),
        revoke: jest.fn(async () => undefined),
      },
      throwingMetrics,
    );

    await expect(
      apiKeys.create(
        actor,
        { name: 'worker', scopes: ['usage:read'] },
        context,
      ),
    ).resolves.toMatchObject({ apiKey: { id: issued.id } });
    await expect(
      apiKeys.revoke(actor, issued.id, context),
    ).resolves.toBeUndefined();
    expect(throwingMetrics.observeTransaction).toHaveBeenCalledTimes(2);
  });
});

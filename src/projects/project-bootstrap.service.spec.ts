import { jest } from '@jest/globals';
import { randomUUID } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { MetricsService } from '../observability/metrics.service.js';
import { ProjectBootstrapService } from './project-bootstrap.service.js';

describe('ProjectBootstrapService observability', () => {
  const issued = {
    digest: Buffer.alloc(32),
    id: randomUUID(),
    plaintext: `mq_${randomUUID()}.${'a'.repeat(43)}`,
    prefix: `mq_${randomUUID()}`,
  };

  function successfulTransaction() {
    const project = {
      createdAt: new Date(),
      dailyQuotaUnits: 10n,
      id: randomUUID(),
      name: 'observed-project',
      updatedAt: new Date(),
    };
    const apiKey = {
      createdAt: new Date(),
      id: issued.id,
      name: 'initial-admin',
      prefix: issued.prefix,
      projectId: project.id,
      revokedAt: null,
      scopes: ['usage:write', 'usage:read', 'keys:manage', 'audit:read'],
      secretDigest: issued.digest,
      status: 'ACTIVE',
    };
    const tx = {
      apiKey: { create: jest.fn(async () => apiKey) },
      project: { create: jest.fn(async () => project) },
    };
    return {
      apiKey,
      prisma: {
        $transaction: jest.fn(
          async (operation: (value: typeof tx) => unknown) => operation(tx),
        ),
      },
      project,
    };
  }

  it('times a successful bootstrap transaction', async () => {
    const metrics = new MetricsService();
    const fixture = successfulTransaction();
    const service = new ProjectBootstrapService(
      fixture.prisma as never,
      { issue: jest.fn(() => issued) } as never,
      { recordProjectCreated: jest.fn(async () => undefined) } as never,
      metrics,
    );

    await expect(
      service.bootstrap(
        { dailyQuotaUnits: 10, name: 'observed-project' },
        { requestId: randomUUID() },
      ),
    ).resolves.toMatchObject({ project: { id: fixture.project.id } });
    expect(await metrics.exposition()).toContain(
      'db_transaction_duration_seconds_count{transaction="PROJECT_BOOTSTRAP"} 1',
    );
  });

  it('times a failed transaction and preserves the mapped dependency error', async () => {
    const metrics = new MetricsService();
    const service = new ProjectBootstrapService(
      {
        $transaction: jest.fn(async () => Promise.reject({ code: 'P1001' })),
      } as never,
      { issue: jest.fn(() => issued) } as never,
      {} as never,
      metrics,
    );

    await expect(
      service.bootstrap(
        { dailyQuotaUnits: 10, name: 'observed-project' },
        { requestId: randomUUID() },
      ),
    ).rejects.toMatchObject({ problem: { code: 'DEPENDENCY_UNAVAILABLE' } });
    expect(await metrics.exposition()).toContain(
      'db_transaction_duration_seconds_count{transaction="PROJECT_BOOTSTRAP"} 1',
    );
  });

  it('does not replace a committed result when transaction metrics throw', async () => {
    const fixture = successfulTransaction();
    const service = new ProjectBootstrapService(
      fixture.prisma as never,
      { issue: jest.fn(() => issued) } as never,
      { recordProjectCreated: jest.fn(async () => undefined) } as never,
      {
        observeTransaction: jest.fn(() => {
          throw new Error('metric canary');
        }),
      } as never,
    );

    await expect(
      service.bootstrap(
        { dailyQuotaUnits: 10, name: 'observed-project' },
        { requestId: randomUUID() },
      ),
    ).resolves.toMatchObject({ project: { id: fixture.project.id } });
  });
});

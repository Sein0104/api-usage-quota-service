import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { beforeEach, jest } from '@jest/globals';
import { Pool } from 'pg';
import { ApiKeyCredentialService } from '../../src/api-keys/api-key-credential.service.js';
import { ApiKeysRepository } from '../../src/api-keys/api-keys.repository.js';
import { ApiKeysService } from '../../src/api-keys/api-keys.service.js';
import { AuditWriteRepository } from '../../src/audit/audit-write.repository.js';
import { CursorCodec } from '../../src/common/pagination/cursor-codec.js';
import { cryptoApiKeyCredentialRandom } from '../../src/common/security/security.tokens.js';
import { PrismaService } from '../../src/database/prisma.service.js';
import { ProjectBootstrapService } from '../../src/projects/project-bootstrap.service.js';
import { cleanDatabase } from '../support/database-cleaner.js';
import { createPostgresTestHarness } from '../support/postgres-test-harness.js';
import {
  acquireTransactionBarrier,
  observeBarrierAndSettle,
} from '../support/concurrency-barrier.js';

jest.setTimeout(120_000);

interface TrackedPromise<T> {
  promise: Promise<T>;
  state(): 'pending' | 'fulfilled' | 'rejected';
}

function track<T>(promise: Promise<T>): TrackedPromise<T> {
  let current: ReturnType<TrackedPromise<T>['state']> = 'pending';
  void promise.then(
    () => {
      current = 'fulfilled';
    },
    () => {
      current = 'rejected';
    },
  );
  return { promise, state: () => current };
}

async function waitForBlockedQueries(
  pool: Pool,
  matches: (queries: string[]) => boolean,
): Promise<string[]> {
  let observed: string[] = [];
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const result = await pool.query<{ query: string }>(`
      SELECT query
      FROM pg_stat_activity
      WHERE datname = current_database()
        AND pid <> pg_backend_pid()
        AND state = 'active'
        AND wait_event_type = 'Lock'
    `);
    observed = result.rows.map(({ query }) => query);
    if (matches(observed)) return observed;
    await delay(20);
  }
  throw new Error(
    `Expected blocked queries were not observed: ${observed.join(' | ')}`,
  );
}

describe('API key revoke concurrency', () => {
  const harness = createPostgresTestHarness();
  let setupPool: Pool;
  let setupPrisma: PrismaService;
  let firstPool: Pool;
  let firstPrisma: PrismaService;
  let secondPool: Pool;
  let secondPrisma: PrismaService;
  let credentials: ApiKeyCredentialService;

  beforeAll(async () => {
    await harness.start();
    await harness.migrate();
    setupPool = new Pool({ connectionString: harness.databaseUrl });
    setupPrisma = new PrismaService(setupPool);
    firstPool = new Pool({ connectionString: harness.databaseUrl, max: 2 });
    firstPrisma = new PrismaService(firstPool);
    secondPool = new Pool({ connectionString: harness.databaseUrl, max: 2 });
    secondPrisma = new PrismaService(secondPool);
    credentials = new ApiKeyCredentialService(
      'p'.repeat(43),
      cryptoApiKeyCredentialRandom,
    );
  });

  beforeEach(async () => cleanDatabase(setupPool));

  afterAll(async () => {
    await Promise.all([
      setupPrisma?.onApplicationShutdown(),
      firstPrisma?.onApplicationShutdown(),
      secondPrisma?.onApplicationShutdown(),
    ]);
    await harness.stop();
  });

  function service(prisma: PrismaService): ApiKeysService {
    return new ApiKeysService(
      prisma,
      credentials,
      new ApiKeysRepository(),
      new AuditWriteRepository(),
      new CursorCodec(),
    );
  }

  async function actor() {
    const created = await new ProjectBootstrapService(
      setupPrisma,
      credentials,
      new AuditWriteRepository(),
    ).bootstrap(
      { dailyQuotaUnits: 1000, name: 'concurrency-project' },
      { requestId: randomUUID() },
    );
    return {
      id: created.apiKey.id,
      projectId: created.project.id,
      scopes: ['keys:manage'] as const,
    };
  }

  it('writes exactly one revoke audit under concurrent requests for one target', async () => {
    const principal = await actor();
    const target = await service(setupPrisma).create(
      principal,
      { name: 'shared-target', scopes: ['usage:read'] },
      { requestId: randomUUID() },
    );

    const barrier = await acquireTransactionBarrier(
      setupPool,
      'SELECT id FROM api_keys WHERE id = $1 FOR UPDATE',
      [target.apiKey.id],
    );
    const revokes = Array.from({ length: 12 }, (_, index) =>
      track(
        service(index % 2 === 0 ? firstPrisma : secondPrisma).revoke(
          principal,
          target.apiKey.id,
          { requestId: randomUUID() },
        ),
      ),
    );
    const outcomes = await observeBarrierAndSettle(
      barrier,
      revokes.map(({ promise }) => promise),
      async () => {
        const blocked = await waitForBlockedQueries(setupPool, (queries) => {
          const normalized = queries.map((query) => query.toLowerCase());
          return (
            normalized.some((query) => query.includes('from api_keys')) &&
            normalized.some((query) => query.includes('from projects'))
          );
        });
        const normalized = blocked.map((query) => query.toLowerCase());
        expect(
          normalized.some((query) => query.includes('from api_keys')),
        ).toBe(true);
        expect(
          normalized.some((query) => query.includes('from projects')),
        ).toBe(true);
        expect(revokes.every(({ state }) => state() === 'pending')).toBe(true);
      },
    );
    expect(outcomes.every(({ status }) => status === 'fulfilled')).toBe(true);

    await expect(
      setupPrisma.auditLog.count({
        where: {
          action: 'API_KEY_REVOKED',
          resourceApiKeyId: target.apiKey.id,
        },
      }),
    ).resolves.toBe(1);
  });

  it('serializes create and revoke races without exceeding the active-key limit', async () => {
    const principal = await actor();
    const apiKeys = service(setupPrisma);
    const targets = [];
    for (let index = 0; index < 19; index += 1) {
      targets.push(
        await apiKeys.create(
          principal,
          { name: `active-${index}`, scopes: ['usage:read'] },
          { requestId: randomUUID() },
        ),
      );
    }

    const barrier = await acquireTransactionBarrier(
      setupPool,
      'SELECT id FROM projects WHERE id = $1 FOR UPDATE',
      [principal.projectId],
    );
    const create = track(
      service(firstPrisma).create(
        principal,
        { name: 'replacement', scopes: ['usage:read'] },
        { requestId: randomUUID() },
      ),
    );
    const revoke = track(
      service(secondPrisma).revoke(principal, targets[0].apiKey.id, {
        requestId: randomUUID(),
      }),
    );
    const [createResult, revokeResult] = await observeBarrierAndSettle(
      barrier,
      [create.promise, revoke.promise],
      async () => {
        const blocked = await waitForBlockedQueries(
          setupPool,
          (queries) =>
            queries.filter((query) =>
              query.toLowerCase().includes('from projects'),
            ).length >= 2,
        );
        expect(
          blocked.filter((query) =>
            query.toLowerCase().includes('from projects'),
          ),
        ).toHaveLength(2);
        expect(create.state()).toBe('pending');
        expect(revoke.state()).toBe('pending');
      },
    );
    const activeCount = await setupPrisma.apiKey.count({
      where: { projectId: principal.projectId, status: 'ACTIVE' },
    });

    expect(activeCount).toBeLessThanOrEqual(20);
    expect(revokeResult.status).toBe('fulfilled');
    await expect(
      setupPrisma.apiKey.findUniqueOrThrow({
        where: { id: targets[0].apiKey.id },
      }),
    ).resolves.toMatchObject({
      status: 'REVOKED',
      revokedAt: expect.any(Date),
    });
    await expect(
      setupPrisma.auditLog.count({
        where: {
          action: 'API_KEY_REVOKED',
          resourceApiKeyId: targets[0].apiKey.id,
        },
      }),
    ).resolves.toBe(1);
    const replacement = await setupPrisma.apiKey.findFirst({
      where: { name: 'replacement', projectId: principal.projectId },
    });
    const createdAuditCount = await setupPrisma.auditLog.count({
      where: { action: 'API_KEY_CREATED', projectId: principal.projectId },
    });
    if (createResult.status === 'rejected') {
      expect(createResult.reason).toMatchObject({
        problem: { code: 'ACTIVE_KEY_LIMIT_REACHED', status: 409 },
      });
      expect(activeCount).toBe(19);
      expect(replacement).toBeNull();
      expect(createdAuditCount).toBe(19);
    } else {
      expect(activeCount).toBe(20);
      expect(replacement).toMatchObject({ status: 'ACTIVE' });
      expect(createdAuditCount).toBe(20);
    }
  });
});

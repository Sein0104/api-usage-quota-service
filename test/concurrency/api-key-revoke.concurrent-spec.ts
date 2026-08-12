import { randomUUID } from 'node:crypto';
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

jest.setTimeout(120_000);

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

    await Promise.all(
      Array.from({ length: 12 }, (_, index) =>
        service(index % 2 === 0 ? firstPrisma : secondPrisma).revoke(
          principal,
          target.apiKey.id,
          { requestId: randomUUID() },
        ),
      ),
    );

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

    const [createResult, revokeResult] = await Promise.allSettled([
      service(firstPrisma).create(
        principal,
        { name: 'replacement', scopes: ['usage:read'] },
        { requestId: randomUUID() },
      ),
      service(secondPrisma).revoke(principal, targets[0].apiKey.id, {
        requestId: randomUUID(),
      }),
    ]);
    const activeCount = await setupPrisma.apiKey.count({
      where: { projectId: principal.projectId, status: 'ACTIVE' },
    });

    expect(activeCount).toBeLessThanOrEqual(20);
    expect(revokeResult.status).toBe('fulfilled');
    if (createResult.status === 'rejected') {
      expect(createResult.reason).toMatchObject({
        problem: { code: 'ACTIVE_KEY_LIMIT_REACHED', status: 409 },
      });
      expect(activeCount).toBe(19);
    } else {
      expect(activeCount).toBe(20);
    }
  });
});

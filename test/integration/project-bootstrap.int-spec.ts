import { randomUUID } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { beforeEach, jest } from '@jest/globals';
import { Pool } from 'pg';
import { ApiKeyCredentialService } from '../../src/api-keys/api-key-credential.service.js';
import { AuditWriteRepository } from '../../src/audit/audit-write.repository.js';
import { ProblemException } from '../../src/common/http/problem.exception.js';
import { cryptoApiKeyCredentialRandom } from '../../src/common/security/security.tokens.js';
import { PrismaService } from '../../src/database/prisma.service.js';
import { ProjectBootstrapService } from '../../src/projects/project-bootstrap.service.js';
import { cleanDatabase } from '../support/database-cleaner.js';
import { createPostgresTestHarness } from '../support/postgres-test-harness.js';

jest.setTimeout(120_000);

describe('Project bootstrap transaction', () => {
  const harness = createPostgresTestHarness();
  let pool: Pool;
  let prisma: PrismaService;

  beforeAll(async () => {
    await harness.start();
    await harness.migrate();
    pool = new Pool({ connectionString: harness.databaseUrl });
    prisma = new PrismaService(pool);
  });

  beforeEach(async () => {
    await cleanDatabase(pool);
  });

  afterAll(async () => {
    await prisma?.onApplicationShutdown();
    await harness.stop();
  });

  function service(
    auditWriter = new AuditWriteRepository(),
  ): ProjectBootstrapService {
    return new ProjectBootstrapService(
      prisma,
      new ApiKeyCredentialService('p'.repeat(43), cryptoApiKeyCredentialRandom),
      auditWriter,
    );
  }

  it('persists a project, its initial key, and exactly one safe project audit in one transaction', async () => {
    const requestId = randomUUID();
    const result = await service().bootstrap(
      { dailyQuotaUnits: 1000, name: 'portfolio-demo' },
      { requestId },
    );

    const projects = await pool.query(
      'SELECT id, name, daily_quota_units FROM projects',
    );
    const keys = await pool.query(
      'SELECT id, project_id, name, prefix, secret_digest, scopes FROM api_keys',
    );
    const audits = await pool.query(
      'SELECT action, actor_key_id, resource_api_key_id, request_id, metadata FROM audit_logs',
    );

    expect(projects.rows).toEqual([
      expect.objectContaining({
        id: result.project.id,
        name: 'portfolio-demo',
        daily_quota_units: '1000',
      }),
    ]);
    expect(keys.rows).toEqual([
      expect.objectContaining({
        id: result.apiKey.id,
        name: 'initial-admin',
        prefix: result.apiKey.prefix,
        project_id: result.project.id,
        scopes: ['usage:write', 'usage:read', 'keys:manage', 'audit:read'],
      }),
    ]);
    expect(keys.rows[0]?.secret_digest).not.toEqual(
      Buffer.from(result.plaintext, 'utf8'),
    );
    expect(audits.rows).toEqual([
      expect.objectContaining({
        action: 'PROJECT_CREATED',
        actor_key_id: null,
        request_id: requestId,
        resource_api_key_id: null,
        metadata: {
          dailyQuotaUnits: 1000,
          initialApiKeyId: result.apiKey.id,
          projectName: 'portfolio-demo',
        },
      }),
    ]);
    expect(
      JSON.stringify({ audits: audits.rows, keys: keys.rows }),
    ).not.toContain(result.plaintext);
  });

  it('allows duplicate project names and creates distinct projects, keys, and audits', async () => {
    await service().bootstrap(
      { dailyQuotaUnits: 1, name: 'duplicate-name' },
      { requestId: randomUUID() },
    );
    await service().bootstrap(
      { dailyQuotaUnits: 1, name: 'duplicate-name' },
      { requestId: randomUUID() },
    );

    await expect(pool.query('SELECT id FROM projects')).resolves.toMatchObject({
      rowCount: 2,
    });
    await expect(pool.query('SELECT id FROM api_keys')).resolves.toMatchObject({
      rowCount: 2,
    });
    await expect(
      pool.query('SELECT id FROM audit_logs'),
    ).resolves.toMatchObject({
      rowCount: 2,
    });
  });

  it('rolls back the project and initial key when the project audit write fails', async () => {
    const failingAuditWriter = {
      recordProjectCreated: async (): Promise<void> => {
        throw new Error('forced audit write failure');
      },
      recordApiKeyCreated: async (): Promise<void> => undefined,
    } as AuditWriteRepository;

    await expect(
      service(failingAuditWriter).bootstrap(
        { dailyQuotaUnits: 1000, name: 'rollback-project' },
        { requestId: randomUUID() },
      ),
    ).rejects.toThrow('forced audit write failure');

    for (const table of ['projects', 'api_keys', 'audit_logs']) {
      await expect(
        pool.query(`SELECT count(*)::int AS count FROM ${table}`),
      ).resolves.toMatchObject({ rows: [{ count: 0 }] });
    }
  });

  it('maps known database availability errors without exposing an internal message', async () => {
    const unavailablePrisma = {
      $transaction: async (): Promise<never> => {
        throw Object.assign(new Error('database socket unavailable'), {
          code: 'P1001',
        });
      },
    } as unknown as PrismaService;
    const unavailable = new ProjectBootstrapService(
      unavailablePrisma,
      new ApiKeyCredentialService('p'.repeat(43), cryptoApiKeyCredentialRandom),
      new AuditWriteRepository(),
    );

    await expect(
      unavailable.bootstrap(
        { dailyQuotaUnits: 1000, name: 'unavailable' },
        { requestId: randomUUID() },
      ),
    ).rejects.toMatchObject<Partial<ProblemException>>({
      problem: expect.objectContaining({
        code: 'DEPENDENCY_UNAVAILABLE',
        detail: 'A required dependency is temporarily unavailable.',
      }),
    });
  });
});

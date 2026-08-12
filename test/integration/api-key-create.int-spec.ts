import { randomUUID } from 'node:crypto';
import { beforeEach, jest } from '@jest/globals';
import { Pool } from 'pg';
import { ApiKeyCredentialService } from '../../src/api-keys/api-key-credential.service.js';
import { ApiKeysRepository } from '../../src/api-keys/api-keys.repository.js';
import { ApiKeysService } from '../../src/api-keys/api-keys.service.js';
import { AuditWriteRepository } from '../../src/audit/audit-write.repository.js';
import { cryptoApiKeyCredentialRandom } from '../../src/common/security/security.tokens.js';
import { PrismaService } from '../../src/database/prisma.service.js';
import { ProjectBootstrapService } from '../../src/projects/project-bootstrap.service.js';
import { cleanDatabase } from '../support/database-cleaner.js';
import { createPostgresTestHarness } from '../support/postgres-test-harness.js';

jest.setTimeout(120_000);

describe('API key creation transaction', () => {
  const harness = createPostgresTestHarness();
  let pool: Pool;
  let prisma: PrismaService;

  beforeAll(async () => {
    await harness.start();
    await harness.migrate();
    pool = new Pool({ connectionString: harness.databaseUrl });
    prisma = new PrismaService(pool);
  });

  beforeEach(async () => cleanDatabase(pool));

  afterAll(async () => {
    await prisma?.onApplicationShutdown();
    await harness.stop();
  });

  async function actor() {
    const credentials = new ApiKeyCredentialService(
      'p'.repeat(43),
      cryptoApiKeyCredentialRandom,
    );
    const bootstrapped = await new ProjectBootstrapService(
      prisma,
      credentials,
      new AuditWriteRepository(),
    ).bootstrap(
      { dailyQuotaUnits: 1000, name: 'transaction-project' },
      { requestId: randomUUID() },
    );
    return {
      credentials,
      id: bootstrapped.apiKey.id,
      projectId: bootstrapped.project.id,
      scopes: ['keys:manage'] as const,
    };
  }

  function service(
    credentials: ApiKeyCredentialService,
    writer: AuditWriteRepository = new AuditWriteRepository(),
  ): ApiKeysService {
    return new ApiKeysService(
      prisma,
      credentials,
      new ApiKeysRepository(),
      writer,
    );
  }

  it('commits a safe API_KEY_CREATED audit with its key', async () => {
    const principal = await actor();
    const created = await service(principal.credentials).create(
      principal,
      { name: 'created-key', scopes: ['audit:read', 'usage:read'] },
      { requestId: randomUUID() },
    );
    const audit = await pool.query(
      "SELECT action, actor_key_id, resource_api_key_id, metadata FROM audit_logs WHERE action = 'API_KEY_CREATED'",
    );
    expect(created.apiKey.scopes).toEqual(['usage:read', 'audit:read']);
    expect(audit.rows).toEqual([
      expect.objectContaining({
        action: 'API_KEY_CREATED',
        actor_key_id: principal.id,
        resource_api_key_id: created.apiKey.id,
        metadata: {
          name: 'created-key',
          prefix: created.apiKey.prefix,
          scopes: ['usage:read', 'audit:read'],
        },
      }),
    ]);
    expect(JSON.stringify(audit.rows)).not.toContain(created.plaintext);
  });

  it('rolls back the created key when the audit writer fails', async () => {
    const principal = await actor();
    const failingWriter = {
      recordApiKeyCreated: async (): Promise<void> => {
        throw new Error('forced audit failure');
      },
      recordProjectCreated: async (): Promise<void> => undefined,
    } as AuditWriteRepository;
    await expect(
      service(principal.credentials, failingWriter).create(
        principal,
        { name: 'rolled-back-key', scopes: ['usage:read'] },
        { requestId: randomUUID() },
      ),
    ).rejects.toThrow('forced audit failure');
    await expect(
      pool.query(
        "SELECT count(*)::int AS count FROM api_keys WHERE name = 'rolled-back-key'",
      ),
    ).resolves.toMatchObject({ rows: [{ count: 0 }] });
  });

  it('allows exactly 19 concurrent creates after bootstrap and rejects six at the active-key limit', async () => {
    const principal = await actor();
    const apiKeys = service(principal.credentials);
    const results = await Promise.all(
      Array.from({ length: 25 }, (_, index) =>
        apiKeys
          .create(
            principal,
            { name: `parallel-${index}`, scopes: ['usage:read'] },
            { requestId: randomUUID() },
          )
          .then(() => 'success' as const)
          .catch((error: unknown) =>
            error instanceof Error && 'problem' in error
              ? ((error as { problem: { code: string } }).problem
                  .code as string)
              : 'unexpected',
          ),
      ),
    );
    expect(results.filter((result) => result === 'success')).toHaveLength(19);
    expect(
      results.filter((result) => result === 'ACTIVE_KEY_LIMIT_REACHED'),
    ).toHaveLength(6);
    await expect(
      pool.query(
        "SELECT count(*)::int AS count FROM api_keys WHERE status = 'ACTIVE'",
      ),
    ).resolves.toMatchObject({ rows: [{ count: 20 }] });
    await expect(
      pool.query(
        "SELECT count(*)::int AS count FROM audit_logs WHERE action = 'API_KEY_CREATED'",
      ),
    ).resolves.toMatchObject({ rows: [{ count: 19 }] });
  });
});

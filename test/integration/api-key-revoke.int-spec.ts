import { Buffer } from 'node:buffer';
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
import { MetricsService } from '../../src/observability/metrics.service.js';
import { cleanDatabase } from '../support/database-cleaner.js';
import { createPostgresTestHarness } from '../support/postgres-test-harness.js';

jest.setTimeout(120_000);

describe('API key list and revoke transactions', () => {
  const harness = createPostgresTestHarness();
  let pool: Pool;
  let prisma: PrismaService;
  let credentials: ApiKeyCredentialService;

  beforeAll(async () => {
    await harness.start();
    await harness.migrate();
    pool = new Pool({ connectionString: harness.databaseUrl });
    prisma = new PrismaService(pool);
    credentials = new ApiKeyCredentialService(
      'p'.repeat(43),
      cryptoApiKeyCredentialRandom,
    );
  });

  beforeEach(async () => cleanDatabase(pool));

  afterAll(async () => {
    await prisma?.onApplicationShutdown();
    await harness.stop();
  });

  async function bootstrap(name: string) {
    const created = await new ProjectBootstrapService(
      prisma,
      credentials,
      new AuditWriteRepository(),
      new MetricsService(),
    ).bootstrap({ dailyQuotaUnits: 1000, name }, { requestId: randomUUID() });
    return {
      id: created.apiKey.id,
      projectId: created.project.id,
      scopes: ['keys:manage'] as const,
    };
  }

  function service(
    writer: AuditWriteRepository = new AuditWriteRepository(),
  ): ApiKeysService {
    return new ApiKeysService(
      prisma,
      credentials,
      new ApiKeysRepository(),
      writer,
      new CursorCodec(),
      new MetricsService(),
    );
  }

  it('paginates same-timestamp keys with no skips or duplicates and isolates tenants', async () => {
    const actor = await bootstrap('project-a');
    const other = await bootstrap('project-b');
    const apiKeys = service();
    const created = await Promise.all(
      ['a', 'b', 'c', 'd'].map((name) =>
        apiKeys.create(
          actor,
          { name, scopes: ['usage:read'] },
          { requestId: randomUUID() },
        ),
      ),
    );
    await apiKeys.create(
      other,
      { name: 'other-tenant', scopes: ['usage:read'] },
      { requestId: randomUUID() },
    );
    const actorTimestamp = new Date('2026-08-12T12:34:55.789Z');
    const timestamp = new Date('2026-08-12T12:34:56.789Z');
    await prisma.apiKey.update({
      data: { createdAt: actorTimestamp },
      where: { id: actor.id },
    });
    await prisma.apiKey.updateMany({
      data: { createdAt: timestamp },
      where: { id: { in: created.map(({ apiKey }) => apiKey.id) } },
    });

    const first = await apiKeys.list(actor, { cursor: null, limit: 2 });
    const second = await apiKeys.list(actor, {
      cursor: new CursorCodec().decode(first.nextCursor!),
      limit: 2,
    });
    const third = await apiKeys.list(actor, {
      cursor: new CursorCodec().decode(second.nextCursor!),
      limit: 2,
    });
    const ids = [...first.items, ...second.items, ...third.items].map(
      (item) => item.id,
    );

    expect(new Set(ids).size).toBe(ids.length);
    const expectedIds = created
      .map(({ apiKey }) => apiKey.id)
      .sort()
      .reverse()
      .concat(actor.id);
    expect(ids).toEqual(expectedIds);
    expect(ids).not.toContain(other.id);
    expect(third.nextCursor).toBeNull();
    expect(JSON.stringify([first, second, third]).toLowerCase()).not.toContain(
      'secretdigest',
    );
  });

  it('revokes once with correlated safe audit and treats a repeat as idempotent', async () => {
    const actor = await bootstrap('revoke-project');
    const target = await service().create(
      actor,
      { name: 'target', scopes: ['usage:read'] },
      { requestId: randomUUID() },
    );
    const requestId = randomUUID();

    await service().revoke(actor, target.apiKey.id, { requestId });
    await service().revoke(actor, target.apiKey.id, {
      requestId: randomUUID(),
    });

    const page = await service().list(actor, { cursor: null, limit: 50 });
    const revokedItem = page.items.find((item) => item.id === target.apiKey.id);

    const key = await prisma.apiKey.findUniqueOrThrow({
      where: { id: target.apiKey.id },
    });
    const audits = await prisma.auditLog.findMany({
      where: { action: 'API_KEY_REVOKED', resourceApiKeyId: target.apiKey.id },
    });
    expect(key.status).toBe('REVOKED');
    expect(key.revokedAt).toBeInstanceOf(Date);
    expect(revokedItem).toEqual({
      id: target.apiKey.id,
      name: 'target',
      prefix: target.apiKey.prefix,
      scopes: ['usage:read'],
      status: 'REVOKED',
      createdAt: target.apiKey.createdAt.toISOString(),
      revokedAt: key.revokedAt!.toISOString(),
    });
    expect(Object.keys(revokedItem!)).toEqual([
      'id',
      'name',
      'prefix',
      'scopes',
      'status',
      'createdAt',
      'revokedAt',
    ]);
    expect(audits).toEqual([
      expect.objectContaining({
        actorKeyId: actor.id,
        metadata: { name: 'target', prefix: target.apiKey.prefix },
        projectId: actor.projectId,
        requestId,
        resourceApiKeyId: target.apiKey.id,
      }),
    ]);
    expect(JSON.stringify(audits)).not.toContain(target.plaintext);
    expect(JSON.stringify(audits)).not.toContain(
      Buffer.from(target.apiKey.secretDigest).toString('base64'),
    );
    expect(JSON.stringify(revokedItem).toLowerCase()).not.toContain('secret');
    expect(JSON.stringify(revokedItem).toLowerCase()).not.toContain('digest');
  });

  it('rejects current, cross-tenant, and nonexistent keys without writing or auditing', async () => {
    const actor = await bootstrap('project-a');
    const other = await bootstrap('project-b');
    const apiKeys = service();

    await expect(
      apiKeys.revoke(actor, actor.id, { requestId: randomUUID() }),
    ).rejects.toMatchObject({
      problem: { code: 'CANNOT_REVOKE_CURRENT_KEY', status: 409 },
    });
    for (const id of [other.id, randomUUID()]) {
      await expect(
        apiKeys.revoke(actor, id, { requestId: randomUUID() }),
      ).rejects.toMatchObject({
        problem: { code: 'RESOURCE_NOT_FOUND', status: 404 },
      });
    }
    await expect(
      prisma.auditLog.count({ where: { action: 'API_KEY_REVOKED' } }),
    ).resolves.toBe(0);
    await expect(
      prisma.apiKey.count({ where: { status: 'REVOKED' } }),
    ).resolves.toBe(0);
  });

  it('rolls back the status change when the revoke audit writer fails', async () => {
    const actor = await bootstrap('rollback-project');
    const target = await service().create(
      actor,
      { name: 'rollback-target', scopes: ['usage:read'] },
      { requestId: randomUUID() },
    );
    const writer = {
      recordApiKeyCreated: async (): Promise<void> => undefined,
      recordApiKeyRevoked: async (): Promise<void> => {
        throw new Error('forced revoke audit failure');
      },
      recordProjectCreated: async (): Promise<void> => undefined,
    } as AuditWriteRepository;

    await expect(
      service(writer).revoke(actor, target.apiKey.id, {
        requestId: randomUUID(),
      }),
    ).rejects.toThrow('forced revoke audit failure');
    await expect(
      prisma.apiKey.findUniqueOrThrow({ where: { id: target.apiKey.id } }),
    ).resolves.toMatchObject({ status: 'ACTIVE', revokedAt: null });
  });
});

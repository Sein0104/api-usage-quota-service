import { beforeEach, jest } from '@jest/globals';
import { randomUUID } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { Pool } from 'pg';
import type { Prisma } from '../../src/generated/prisma/client.js';
import { PrismaService } from '../../src/database/prisma.service.js';
import { UsageRepository } from '../../src/usage/usage.repository.js';
import { UsageService } from '../../src/usage/usage.service.js';
import { payloadHash } from '../../src/usage/domain/payload-hash.js';
import type { AuthenticatedApiKey } from '../../src/api-keys/auth/authenticated-api-key.js';
import { cleanDatabase } from '../support/database-cleaner.js';
import { createPostgresTestHarness } from '../support/postgres-test-harness.js';

jest.setTimeout(120_000);

describe('usage ingest transaction', () => {
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

  async function createActor(
    quota: number,
    projectName: string = randomUUID(),
  ): Promise<AuthenticatedApiKey> {
    const projectId = randomUUID();
    const keyId = randomUUID();
    await pool.query(
      `INSERT INTO projects (id, name, daily_quota_units)
       VALUES ($1, $2, $3)`,
      [projectId, projectName, quota],
    );
    await pool.query(
      `INSERT INTO api_keys
         (id, project_id, name, prefix, secret_digest, scopes)
       VALUES ($1::uuid, $2::uuid, 'usage-writer',
         'mq_' || $1::uuid::text, $3, $4)`,
      [keyId, projectId, Buffer.alloc(32, 1), ['usage:write']],
    );
    return { id: keyId, projectId, scopes: ['usage:write'] };
  }

  async function createOtherKey(
    actor: AuthenticatedApiKey,
  ): Promise<AuthenticatedApiKey> {
    const id = randomUUID();
    await pool.query(
      `INSERT INTO api_keys
         (id, project_id, name, prefix, secret_digest, scopes)
       VALUES ($1::uuid, $2::uuid, 'other-writer',
         'mq_' || $1::uuid::text, $3, $4)`,
      [id, actor.projectId, Buffer.alloc(32, 2), ['usage:write']],
    );
    return { id, projectId: actor.projectId, scopes: ['usage:write'] };
  }

  function ingest(
    service: UsageService,
    actor: AuthenticatedApiKey,
    idempotencyKey: string,
    units: number,
    receivedAt = new Date('2026-08-11T23:59:59.999Z'),
  ) {
    return service.ingest(actor, { units }, idempotencyKey, {
      receivedAt,
      requestId: randomUUID(),
    });
  }

  it('commits accepted and quota-exceeded terminal rows without increasing quota on rejection', async () => {
    const actor = await createActor(3);
    const service = new UsageService(prisma, new UsageRepository());

    const accepted = await ingest(service, actor, randomUUID(), 3);
    const exceeded = await ingest(service, actor, randomUUID(), 1);

    expect(accepted).toMatchObject({
      decision: 'ACCEPTED',
      responseStatus: 200,
      units: 3n,
      usageDate: '2026-08-11',
      quota: {
        limit: 3n,
        remaining: 0n,
        resetAt: new Date('2026-08-12T00:00:00.000Z'),
      },
    });
    expect(exceeded).toMatchObject({
      decision: 'QUOTA_EXCEEDED',
      responseStatus: 429,
      units: 1n,
      quota: { limit: 3n, remaining: 0n },
    });
    await expect(
      pool.query(
        `SELECT decision, response_status, count(*)::int AS count
         FROM usage_events GROUP BY decision, response_status ORDER BY response_status`,
      ),
    ).resolves.toMatchObject({
      rows: [
        { count: 1, decision: 'ACCEPTED', response_status: 200 },
        { count: 1, decision: 'QUOTA_EXCEEDED', response_status: 429 },
      ],
    });
    await expect(
      pool.query('SELECT used_units FROM daily_usage'),
    ).resolves.toMatchObject({ rows: [{ used_units: '3' }] });
  });

  it('replays a quota-exceeded snapshot without a second quota change', async () => {
    const actor = await createActor(2);
    const service = new UsageService(prisma, new UsageRepository());
    await ingest(service, actor, randomUUID(), 2);
    const key = randomUUID();

    const first = await ingest(service, actor, key, 1);
    const replay = await ingest(service, actor, key, 1);

    expect(replay).toEqual(first);
    expect(replay).toMatchObject({
      decision: 'QUOTA_EXCEEDED',
      responseStatus: 429,
      quota: { limit: 2n, remaining: 0n },
    });
    await expect(
      pool.query('SELECT used_units FROM daily_usage'),
    ).resolves.toMatchObject({ rows: [{ used_units: '2' }] });
  });

  it('keeps the partial remaining snapshot when the next request exceeds quota', async () => {
    const actor = await createActor(5);
    const service = new UsageService(prisma, new UsageRepository());
    await ingest(service, actor, randomUUID(), 3);

    const exceeded = await ingest(service, actor, randomUUID(), 3);

    expect(exceeded).toMatchObject({
      decision: 'QUOTA_EXCEEDED',
      quota: { limit: 5n, remaining: 2n },
    });
    await expect(
      pool.query('SELECT used_units FROM daily_usage'),
    ).resolves.toMatchObject({ rows: [{ used_units: '3' }] });
  });

  it('creates a zero-used daily row when the first request exceeds quota', async () => {
    const actor = await createActor(2);
    const exceeded = await ingest(
      new UsageService(prisma, new UsageRepository()),
      actor,
      randomUUID(),
      3,
    );

    expect(exceeded).toMatchObject({
      decision: 'QUOTA_EXCEEDED',
      quota: { limit: 2n, remaining: 2n },
    });
    await expect(
      pool.query('SELECT used_units FROM daily_usage'),
    ).resolves.toMatchObject({ rows: [{ used_units: '0' }] });
  });

  it('replays the same project terminal across API keys while retaining the original key id', async () => {
    const actor = await createActor(10);
    const other = await createOtherKey(actor);
    const service = new UsageService(prisma, new UsageRepository());
    const key = randomUUID();

    const first = await ingest(service, actor, key, 4);
    const replay = await ingest(service, other, key, 4);

    expect(replay).toEqual(first);
    await expect(
      pool.query(
        'SELECT api_key_id, count(*)::int AS count FROM usage_events GROUP BY api_key_id',
      ),
    ).resolves.toMatchObject({
      rows: [{ api_key_id: actor.id, count: 1 }],
    });
    await expect(
      pool.query('SELECT used_units FROM daily_usage'),
    ).resolves.toMatchObject({ rows: [{ used_units: '4' }] });
  });

  it('rejects a different payload for the same project key without changing quota', async () => {
    const actor = await createActor(10);
    const service = new UsageService(prisma, new UsageRepository());
    const key = randomUUID();
    await ingest(service, actor, key, 2);

    await expect(ingest(service, actor, key, 3)).rejects.toMatchObject({
      problem: { code: 'IDEMPOTENCY_KEY_REUSED', status: 409 },
    });
    await expect(
      pool.query('SELECT used_units FROM daily_usage'),
    ).resolves.toMatchObject({ rows: [{ used_units: '2' }] });
    await expect(
      pool.query('SELECT count(*)::int AS count FROM usage_events'),
    ).resolves.toMatchObject({ rows: [{ count: 1 }] });
  });

  it('treats the same idempotency key in another project independently', async () => {
    const firstActor = await createActor(10, 'first-project');
    const secondActor = await createActor(20, 'second-project');
    const service = new UsageService(prisma, new UsageRepository());
    const key = randomUUID();

    const first = await ingest(service, firstActor, key, 2);
    const second = await ingest(service, secondActor, key, 5);

    expect(first.eventId).not.toBe(second.eventId);
    await expect(
      pool.query(
        'SELECT project_id, used_units FROM daily_usage ORDER BY project_id',
      ),
    ).resolves.toMatchObject({
      rows: expect.arrayContaining([
        { project_id: firstActor.projectId, used_units: '2' },
        { project_id: secondActor.projectId, used_units: '5' },
      ]),
    });
  });

  it('rolls back the PENDING event and quota update when finalization fails', async () => {
    const actor = await createActor(10);
    class FailingRepository extends UsageRepository {
      override async finalize(
        tx: Prisma.TransactionClient,
        projectId: string,
        input: Parameters<UsageRepository['finalize']>[2],
      ): Promise<Awaited<ReturnType<UsageRepository['finalize']>>> {
        await super.finalize(tx, projectId, input);
        throw new Error('forced finalization failure');
      }
    }
    const service = new UsageService(prisma, new FailingRepository());

    await expect(ingest(service, actor, randomUUID(), 2)).rejects.toThrow(
      'forced finalization failure',
    );
    await expect(
      pool.query('SELECT count(*)::int AS count FROM usage_events'),
    ).resolves.toMatchObject({ rows: [{ count: 0 }] });
    await expect(
      pool.query('SELECT count(*)::int AS count FROM daily_usage'),
    ).resolves.toMatchObject({ rows: [{ count: 0 }] });
  });

  it('rolls back when exact PENDING finalization updates no row', async () => {
    const actor = await createActor(10);
    class MissingFinalizationRepository extends UsageRepository {
      override async finalize(): Promise<null> {
        return null;
      }
    }
    const service = new UsageService(
      prisma,
      new MissingFinalizationRepository(),
    );

    await expect(ingest(service, actor, randomUUID(), 2)).rejects.toThrow(
      'Usage event finalization invariant violated.',
    );
    await expect(
      pool.query('SELECT count(*)::int AS count FROM usage_events'),
    ).resolves.toMatchObject({ rows: [{ count: 0 }] });
    await expect(
      pool.query('SELECT count(*)::int AS count FROM daily_usage'),
    ).resolves.toMatchObject({ rows: [{ count: 0 }] });
  });

  it('finalizes no earlier than a future captured receivedAt', async () => {
    const actor = await createActor(10);
    const receivedAt = new Date('2099-12-31T23:59:59.999Z');
    await ingest(
      new UsageService(prisma, new UsageRepository()),
      actor,
      randomUUID(),
      1,
      receivedAt,
    );

    await expect(
      pool.query('SELECT received_at, finalized_at FROM usage_events'),
    ).resolves.toMatchObject({
      rows: [
        {
          finalized_at: receivedAt,
          received_at: receivedAt,
        },
      ],
    });
  });

  it('treats a committed PENDING row as an internal invariant failure', async () => {
    const actor = await createActor(10);
    const key = randomUUID();
    const receivedAt = new Date('2026-08-11T12:00:00.000Z');
    await pool.query(
      `INSERT INTO usage_events
        (project_id, api_key_id, idempotency_key, payload_hash,
         usage_date, units, received_at)
       VALUES ($1, $2, $3, $4, '2026-08-11', 2, $5)`,
      [actor.projectId, actor.id, key, payloadHash(2), receivedAt],
    );

    await expect(
      ingest(
        new UsageService(prisma, new UsageRepository()),
        actor,
        key,
        2,
        receivedAt,
      ),
    ).rejects.toThrow('Committed PENDING usage event invariant violated.');
    await expect(
      pool.query('SELECT decision FROM usage_events WHERE project_id = $1', [
        actor.projectId,
      ]),
    ).resolves.toMatchObject({ rows: [{ decision: 'PENDING' }] });
  });
});

import { randomUUID } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { beforeEach, jest } from '@jest/globals';
import { Pool } from 'pg';
import {
  clearTimeout as clearTimer,
  setTimeout as setTimer,
} from 'node:timers';
import { setTimeout as delay } from 'node:timers/promises';
import type { AuthenticatedApiKey } from '../../src/api-keys/auth/authenticated-api-key.js';
import type { Prisma } from '../../src/generated/prisma/client.js';
import { PrismaService } from '../../src/database/prisma.service.js';
import { UsageRepository } from '../../src/usage/usage.repository.js';
import { UsageService } from '../../src/usage/usage.service.js';
import { cleanDatabase } from '../support/database-cleaner.js';
import { FinalizeThenFailUsageRepository } from '../support/database-faults.js';
import { FakeClock } from '../support/fake-clock.js';
import { createPostgresTestHarness } from '../support/postgres-test-harness.js';

jest.setTimeout(120_000);

describe('usage transaction rollback', () => {
  const harness = createPostgresTestHarness();
  const clock = new FakeClock(new Date('2026-08-11T12:00:00.000Z'));
  let pool: Pool;
  let prisma: PrismaService;

  beforeAll(async () => {
    await harness.start();
    await harness.migrate();
    pool = new Pool({ connectionString: harness.databaseUrl });
    prisma = new PrismaService(pool);
  });
  beforeEach(async () => {
    clock.set(new Date('2026-08-11T12:00:00.000Z'));
    await cleanDatabase(pool);
  });
  afterAll(async () => {
    await prisma?.onApplicationShutdown();
    await harness.stop();
  });

  async function actor(quota: number): Promise<AuthenticatedApiKey> {
    const projectId = randomUUID();
    const id = randomUUID();
    await pool.query(
      `INSERT INTO projects (id, name, daily_quota_units) VALUES ($1, $2, $3)`,
      [projectId, `rollback-${projectId}`, quota],
    );
    await pool.query(
      `INSERT INTO api_keys
         (id, project_id, name, prefix, secret_digest, scopes)
       VALUES ($1, $2, 'writer', $3, $4, $5)`,
      [id, projectId, `mq_${id}`, Buffer.alloc(32, 4), ['usage:write']],
    );
    return { id, projectId, scopes: ['usage:write'] };
  }

  function ingest(
    service: UsageService,
    principal: AuthenticatedApiKey,
    key: string,
    units: number,
  ) {
    return service.ingest(principal, { units }, key, {
      receivedAt: clock.now(),
      requestId: randomUUID(),
    });
  }

  async function counts(projectId: string) {
    return pool.query(
      `SELECT
         count(*)::int AS count,
         count(*) FILTER (WHERE decision = 'PENDING')::int AS pending
       FROM usage_events WHERE project_id = $1`,
      [projectId],
    );
  }

  it('rolls back an ACCEPTED finalization and lets the same key acquire ownership once', async () => {
    const principal = await actor(10);
    const key = randomUUID();

    await expect(
      ingest(
        new UsageService(prisma, new FinalizeThenFailUsageRepository()),
        principal,
        key,
        2,
      ),
    ).rejects.toThrow('forced failure after usage finalization');
    await expect(counts(principal.projectId)).resolves.toMatchObject({
      rows: [{ count: 0, pending: 0 }],
    });
    await expect(
      pool.query(
        `SELECT count(*)::int AS count FROM daily_usage WHERE project_id = $1`,
        [principal.projectId],
      ),
    ).resolves.toMatchObject({ rows: [{ count: 0 }] });

    await expect(
      ingest(
        new UsageService(prisma, new UsageRepository()),
        principal,
        key,
        2,
      ),
    ).resolves.toMatchObject({ decision: 'ACCEPTED' });
    await expect(counts(principal.projectId)).resolves.toMatchObject({
      rows: [{ count: 1, pending: 0 }],
    });
    await expect(
      pool.query(`SELECT used_units FROM daily_usage WHERE project_id = $1`, [
        principal.projectId,
      ]),
    ).resolves.toMatchObject({ rows: [{ used_units: '2' }] });
  });

  it('rolls back a finalized 429 terminal including its fresh daily row', async () => {
    const principal = await actor(2);

    await expect(
      ingest(
        new UsageService(prisma, new FinalizeThenFailUsageRepository()),
        principal,
        randomUUID(),
        3,
      ),
    ).rejects.toThrow('forced failure after usage finalization');

    await expect(counts(principal.projectId)).resolves.toMatchObject({
      rows: [{ count: 0, pending: 0 }],
    });
    await expect(
      pool.query(
        `SELECT count(*)::int AS count FROM daily_usage WHERE project_id = $1`,
        [principal.projectId],
      ),
    ).resolves.toMatchObject({ rows: [{ count: 0 }] });
  });

  it('lets a waiting same-key transaction acquire ownership after the first owner rolls back', async () => {
    const principal = await actor(10);
    const key = randomUUID();
    let signalInserted!: () => void;
    let releaseOwner!: () => void;
    const inserted = new Promise<void>((resolve) => {
      signalInserted = resolve;
    });
    const release = new Promise<void>((resolve) => {
      releaseOwner = resolve;
    });

    class OpenThenRollbackRepository extends UsageRepository {
      override async insertPending(
        tx: Prisma.TransactionClient,
        input: Parameters<UsageRepository['insertPending']>[1],
      ): Promise<string | null> {
        const eventId = await super.insertPending(tx, input);
        if (eventId === null) throw new Error('first owner did not insert');
        signalInserted();
        await release;
        throw new Error('forced open owner rollback');
      }
    }

    const first = ingest(
      new UsageService(prisma, new OpenThenRollbackRepository()),
      principal,
      key,
      2,
    );
    let waiting: ReturnType<typeof ingest> | undefined;
    let lockObserved = false;
    let observationError: unknown;
    try {
      let insertionTimer: ReturnType<typeof setTimer> | undefined;
      try {
        await Promise.race([
          inserted,
          new Promise<void>((_resolve, reject) => {
            insertionTimer = setTimer(
              () =>
                reject(
                  new Error('first owner insert was not observed within 2s'),
                ),
              2_000,
            );
          }),
        ]);
      } finally {
        if (insertionTimer !== undefined) clearTimer(insertionTimer);
      }
      waiting = ingest(
        new UsageService(prisma, new UsageRepository()),
        principal,
        key,
        2,
      );
      for (let attempt = 0; attempt < 80; attempt += 1) {
        const active = await pool.query<{ count: number }>(
          `SELECT count(*)::int AS count
           FROM pg_stat_activity
           WHERE datname = current_database()
             AND pid <> pg_backend_pid()
             AND wait_event_type = 'Lock'
             AND query ILIKE '%INSERT INTO usage_events%'`,
        );
        if (active.rows[0].count > 0) {
          lockObserved = true;
          break;
        }
        await delay(20);
      }
    } catch (error) {
      observationError = error;
    } finally {
      releaseOwner();
    }
    const settled = await Promise.allSettled(
      waiting === undefined ? [first] : [first, waiting],
    );
    if (observationError !== undefined) throw observationError;
    if (settled.length !== 2) {
      throw new Error('waiting transaction was not started');
    }
    const [firstResult, waitingResult] = settled;
    expect(lockObserved).toBe(true);
    expect(firstResult).toMatchObject({
      status: 'rejected',
      reason: new Error('forced open owner rollback'),
    });
    expect(waitingResult).toMatchObject({
      status: 'fulfilled',
      value: {
        decision: 'ACCEPTED',
        units: 2n,
      },
    });
    await expect(counts(principal.projectId)).resolves.toMatchObject({
      rows: [{ count: 1, pending: 0 }],
    });
    await expect(
      pool.query(`SELECT used_units FROM daily_usage WHERE project_id = $1`, [
        principal.projectId,
      ]),
    ).resolves.toMatchObject({ rows: [{ used_units: '2' }] });
  });
});

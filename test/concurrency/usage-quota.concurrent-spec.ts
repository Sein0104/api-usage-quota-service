import { randomUUID } from 'node:crypto';
import { beforeEach, jest } from '@jest/globals';
import { Pool } from 'pg';
import { PrismaService } from '../../src/database/prisma.service.js';
import { cleanDatabase } from '../support/database-cleaner.js';
import { createPostgresTestHarness } from '../support/postgres-test-harness.js';
import {
  concurrently,
  createUsageActor,
  ingest,
  usageService,
} from './usage-concurrency.helpers.js';

jest.setTimeout(120_000);

describe('usage quota concurrency', () => {
  const harness = createPostgresTestHarness();
  let pool: Pool;
  let prisma: PrismaService;

  beforeAll(async () => {
    await harness.start();
    await harness.migrate();
    pool = new Pool({ connectionString: harness.databaseUrl, max: 10 });
    prisma = new PrismaService(pool);
  });
  beforeEach(async () => cleanDatabase(pool));
  afterAll(async () => {
    await prisma?.onApplicationShutdown();
    await harness.stop();
  });

  it('allows exactly 20 of 100 distinct one-unit requests under quota 20', async () => {
    const actor = await createUsageActor(pool, 20);
    const service = usageService(prisma);
    const results = await concurrently(
      Array.from(
        { length: 100 },
        () => () => ingest(service, actor, randomUUID(), 1),
      ),
    );
    const values = results.map((result) => {
      if (result.status === 'rejected') throw result.reason;
      return result.value;
    });

    expect(
      values.filter(({ decision }) => decision === 'ACCEPTED'),
    ).toHaveLength(20);
    expect(
      values.filter(({ decision }) => decision === 'QUOTA_EXCEEDED'),
    ).toHaveLength(80);
    await expect(
      pool.query(`SELECT used_units FROM daily_usage WHERE project_id = $1`, [
        actor.projectId,
      ]),
    ).resolves.toMatchObject({ rows: [{ used_units: '20' }] });
    await expect(
      pool.query(
        `SELECT count(*)::int AS count,
                count(*) FILTER (WHERE decision = 'PENDING')::int AS pending
         FROM usage_events WHERE project_id = $1`,
        [actor.projectId],
      ),
    ).resolves.toMatchObject({ rows: [{ count: 100, pending: 0 }] });
  });
});

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

describe('usage idempotency concurrency', () => {
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

  it('stores one event, charges once, and returns one terminal for 100 identical requests', async () => {
    const actor = await createUsageActor(pool, 20);
    const service = usageService(prisma);
    const key = randomUUID();
    const results = await concurrently(
      Array.from({ length: 100 }, () => () => ingest(service, actor, key, 1)),
    );
    const values = results.map((result) => {
      if (result.status === 'rejected') throw result.reason;
      return result.value;
    });

    expect(values).toEqual(Array.from({ length: 100 }, () => values[0]));
    await expect(
      pool.query(
        `SELECT count(*)::int AS count,
                count(*) FILTER (WHERE decision = 'PENDING')::int AS pending
         FROM usage_events WHERE project_id = $1`,
        [actor.projectId],
      ),
    ).resolves.toMatchObject({ rows: [{ count: 1, pending: 0 }] });
    await expect(
      pool.query(`SELECT used_units FROM daily_usage WHERE project_id = $1`, [
        actor.projectId,
      ]),
    ).resolves.toMatchObject({ rows: [{ used_units: '1' }] });
  });

  it('chooses one payload winner and rejects every losing payload under a 50/50 race', async () => {
    const actor = await createUsageActor(pool, 20);
    const service = usageService(prisma);
    const key = randomUUID();
    const results = await concurrently([
      ...Array.from({ length: 50 }, () => () => ingest(service, actor, key, 1)),
      ...Array.from({ length: 50 }, () => () => ingest(service, actor, key, 2)),
    ]);
    const fulfilled = results.filter((result) => result.status === 'fulfilled');
    const rejected = results.filter((result) => result.status === 'rejected');
    expect(fulfilled).toHaveLength(50);
    expect(rejected).toHaveLength(50);
    expect(
      rejected.every(
        ({ reason }) => reason?.problem?.code === 'IDEMPOTENCY_KEY_REUSED',
      ),
    ).toBe(true);
    const winnerUnits = fulfilled[0].value.units;
    expect(fulfilled.every(({ value }) => value.units === winnerUnits)).toBe(
      true,
    );
    await expect(
      pool.query(
        `SELECT units, decision FROM usage_events WHERE project_id = $1`,
        [actor.projectId],
      ),
    ).resolves.toMatchObject({
      rows: [{ units: String(winnerUnits), decision: 'ACCEPTED' }],
    });
    await expect(
      pool.query(`SELECT used_units FROM daily_usage WHERE project_id = $1`, [
        actor.projectId,
      ]),
    ).resolves.toMatchObject({ rows: [{ used_units: String(winnerUnits) }] });
  });
});

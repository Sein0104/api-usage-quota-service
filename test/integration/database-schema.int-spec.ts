import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { MigrationStatusService } from '../../src/database/migration-status.service.js';
import { cleanDatabase } from '../support/database-cleaner.js';
import { createPostgresTestHarness } from '../support/postgres-test-harness.js';

const harness = createPostgresTestHarness();
let pool: Pool;

async function insertProject(name = 'Project'): Promise<string> {
  const id = randomUUID();
  await pool.query(
    'INSERT INTO projects (id, name, daily_quota_units) VALUES ($1, $2, 10)',
    [id, name],
  );
  return id;
}

async function insertApiKey(
  projectId: string,
  id: string = randomUUID(),
): Promise<string> {
  await pool.query(
    `INSERT INTO api_keys
      (id, project_id, name, prefix, secret_digest, scopes)
     VALUES ($1::uuid, $2::uuid, 'key', 'mq_' || $1::text, decode(repeat('ab', 32), 'hex'), ARRAY['usage:write'])`,
    [id, projectId],
  );
  return id;
}

describe('PostgreSQL schema migration', () => {
  beforeAll(async () => {
    await harness.start();
    await harness.migrate();
    pool = new Pool({ connectionString: harness.databaseUrl });
  }, 120_000);

  afterEach(async () => {
    if (pool !== undefined) {
      await cleanDatabase(pool);
    }
  });

  afterAll(async () => {
    await pool?.end();
    await harness.stop();
  });

  it('creates the specified tables, enums, foreign keys, and indexes', async () => {
    const tables = await pool.query<{ tablename: string }>(
      `SELECT tablename FROM pg_tables WHERE schemaname = 'public'
       AND tablename = ANY($1::text[]) ORDER BY tablename`,
      [['api_keys', 'audit_logs', 'daily_usage', 'projects', 'usage_events']],
    );
    expect(tables.rows.map((row) => row.tablename)).toEqual([
      'api_keys',
      'audit_logs',
      'daily_usage',
      'projects',
      'usage_events',
    ]);

    const enums = await pool.query<{ typname: string }>(
      `SELECT typname FROM pg_type WHERE typnamespace = 'public'::regnamespace
       AND typtype = 'e' ORDER BY typname`,
    );
    expect(enums.rows.map((row) => row.typname)).toEqual([
      'api_key_status',
      'audit_action',
      'usage_decision',
    ]);

    const indexes = await pool.query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes WHERE schemaname = 'public'
       AND indexname = ANY($1::text[]) ORDER BY indexname`,
      [
        [
          'api_keys_active_project_idx',
          'api_keys_project_cursor_idx',
          'audit_logs_actor_fk_idx',
          'audit_logs_project_cursor_idx',
          'audit_logs_resource_api_key_fk_idx',
          'usage_events_project_api_key_idx',
        ],
      ],
    );
    expect(indexes.rows).toHaveLength(6);
  });

  it('treats applied expected migrations as ready and incomplete history as not ready', async () => {
    const status = new MigrationStatusService(pool);
    expect(await status.isReady()).toBe(true);

    await pool.query(
      `UPDATE public._prisma_migrations
       SET finished_at = NULL
       WHERE migration_name = '202608110001_initial_schema'`,
    );
    expect(await status.isReady()).toBe(false);

    await pool.query(
      `UPDATE public._prisma_migrations
       SET finished_at = now()
       WHERE migration_name = '202608110001_initial_schema'`,
    );
    await pool.query(
      `INSERT INTO public._prisma_migrations
       (id, checksum, finished_at, migration_name, logs, rolled_back_at, started_at, applied_steps_count)
       VALUES (gen_random_uuid()::text, 'test', NULL, 'unrelated_failed_migration', 'failed', NULL, now(), 0)`,
    );
    expect(await status.isReady()).toBe(false);
  });

  it('rejects a usage event that references an API key from another tenant', async () => {
    const projectId = await insertProject('One');
    const otherProjectId = await insertProject('Two');
    const otherKeyId = await insertApiKey(otherProjectId);

    await expect(
      pool.query(
        `INSERT INTO usage_events
          (project_id, api_key_id, idempotency_key, payload_hash, usage_date, units, received_at)
         VALUES ($1, $2, 'd9428888-122b-4f6f-89af-7db6ef06e2d3', decode(repeat('ab', 32), 'hex'), '2026-08-12', 1, '2026-08-12T12:00:00.000Z')`,
        [projectId, otherKeyId],
      ),
    ).rejects.toMatchObject({ code: '23503' });
  });

  it('enforces key schema checks and uniqueness', async () => {
    const projectId = await insertProject();
    const keyId = randomUUID();

    await expect(
      pool.query(
        `INSERT INTO api_keys (id, project_id, name, prefix, secret_digest, scopes)
         VALUES ($1::uuid, $2::uuid, ' key ', 'mq_' || $1::text, decode(repeat('ab', 31), 'hex'), ARRAY['nope'])`,
        [keyId, projectId],
      ),
    ).rejects.toMatchObject({ code: '23514' });

    const duplicateKeyId = await insertApiKey(projectId);
    await expect(insertApiKey(projectId, duplicateKeyId)).rejects.toMatchObject(
      {
        code: '23505',
      },
    );
  });
});

import { randomUUID } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { Pool } from 'pg';
import { MigrationStatusService } from '../../src/database/migration-status.service.js';
import { createPostgresPool } from '../../src/database/postgres-pool.provider.js';
import { cleanDatabase } from '../support/database-cleaner.js';
import { createPostgresTestHarness } from '../support/postgres-test-harness.js';

const harness = createPostgresTestHarness();
let pool: Pool;

async function expectConstraint(
  query: string,
  values: unknown[],
  constraint: string,
): Promise<void> {
  await expect(pool.query(query, values)).rejects.toMatchObject({
    code: '23514',
    constraint,
  });
}

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

  it('defines every key constraint with restrictive deletes and cascading updates', async () => {
    const constraints = await pool.query<{
      conname: string;
      definition: string;
    }>(
      `SELECT conname, pg_get_constraintdef(oid) AS definition
       FROM pg_constraint
       WHERE connamespace = 'public'::regnamespace
         AND conname = ANY($1::text[])`,
      [
        [
          'projects_pkey',
          'api_keys_pkey',
          'api_keys_project_id_id_uq',
          'api_keys_prefix_uq',
          'usage_events_pkey',
          'usage_events_project_idempotency_key_uq',
          'daily_usage_pkey',
          'audit_logs_pkey',
          'api_keys_project_fk',
          'usage_events_project_fk',
          'usage_events_project_api_key_fk',
          'daily_usage_project_fk',
          'audit_logs_project_fk',
          'audit_logs_project_actor_key_fk',
          'audit_logs_project_resource_api_key_fk',
        ],
      ],
    );
    const definitions = new Map(
      constraints.rows.map((row) => [row.conname, row.definition]),
    );

    const expectedKeyDefinitions = {
      projects_pkey: 'PRIMARY KEY (id)',
      api_keys_pkey: 'PRIMARY KEY (id)',
      api_keys_project_id_id_uq: 'UNIQUE (project_id, id)',
      api_keys_prefix_uq: 'UNIQUE (prefix)',
      usage_events_pkey: 'PRIMARY KEY (id)',
      usage_events_project_idempotency_key_uq:
        'UNIQUE (project_id, idempotency_key)',
      daily_usage_pkey: 'PRIMARY KEY (project_id, usage_date)',
      audit_logs_pkey: 'PRIMARY KEY (id)',
    };

    for (const [name, definition] of Object.entries(expectedKeyDefinitions)) {
      expect(definitions.get(name)).toBe(definition);
    }

    for (const name of [
      'api_keys_project_fk',
      'usage_events_project_fk',
      'usage_events_project_api_key_fk',
      'daily_usage_project_fk',
      'audit_logs_project_fk',
      'audit_logs_project_actor_key_fk',
      'audit_logs_project_resource_api_key_fk',
    ]) {
      expect(definitions.get(name)).toContain(
        'ON UPDATE CASCADE ON DELETE RESTRICT',
      );
    }
    expect(definitions.get('usage_events_project_api_key_fk')).toContain(
      'FOREIGN KEY (project_id, api_key_id) REFERENCES api_keys(project_id, id)',
    );
    expect(definitions.get('audit_logs_project_actor_key_fk')).toContain(
      'FOREIGN KEY (project_id, actor_key_id) REFERENCES api_keys(project_id, id)',
    );
    expect(definitions.get('audit_logs_project_resource_api_key_fk')).toContain(
      'FOREIGN KEY (project_id, resource_api_key_id) REFERENCES api_keys(project_id, id)',
    );
  });

  it('defines cursor and partial indexes with the required expressions', async () => {
    const indexes = await pool.query<{ indexname: string; indexdef: string }>(
      `SELECT indexname, indexdef
       FROM pg_indexes
       WHERE schemaname = 'public' AND indexname = ANY($1::text[])`,
      [
        [
          'api_keys_project_cursor_idx',
          'api_keys_active_project_idx',
          'usage_events_project_api_key_idx',
          'audit_logs_project_cursor_idx',
          'audit_logs_actor_fk_idx',
          'audit_logs_resource_api_key_fk_idx',
        ],
      ],
    );
    const definitions = new Map(
      indexes.rows.map((row) => [row.indexname, row.indexdef]),
    );

    expect(definitions.get('api_keys_project_cursor_idx')).toContain(
      '(project_id, created_at DESC, id DESC)',
    );
    expect(definitions.get('audit_logs_project_cursor_idx')).toContain(
      '(project_id, created_at DESC, id DESC)',
    );
    expect(definitions.get('usage_events_project_api_key_idx')).toContain(
      '(project_id, api_key_id)',
    );
    expect(definitions.get('api_keys_active_project_idx')).toContain(
      "WHERE (status = 'ACTIVE'::api_key_status)",
    );
    expect(definitions.get('audit_logs_actor_fk_idx')).toContain(
      'WHERE (actor_key_id IS NOT NULL)',
    );
    expect(definitions.get('audit_logs_resource_api_key_fk_idx')).toContain(
      'WHERE (resource_api_key_id IS NOT NULL)',
    );
  });

  it('distinguishes expected incomplete, unrelated failed, and expected rolled-back migration history', async () => {
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
    expect(await status.isReady()).toBe(true);

    await pool.query(
      `INSERT INTO public._prisma_migrations
       (id, checksum, finished_at, migration_name, logs, rolled_back_at, started_at, applied_steps_count)
       VALUES (gen_random_uuid()::text, 'test', NULL, 'unrelated_failed_migration', 'failed', NULL, now(), 0)`,
    );
    expect(await status.isReady()).toBe(false);

    await pool.query(
      `DELETE FROM public._prisma_migrations
       WHERE migration_name = 'unrelated_failed_migration'`,
    );
    expect(await status.isReady()).toBe(true);

    await pool.query(
      `UPDATE public._prisma_migrations
       SET finished_at = now(), rolled_back_at = now()
       WHERE migration_name = '202608110001_initial_schema'`,
    );
    expect(await status.isReady()).toBe(false);
  });

  it('uses UTC for every connection created by the application pool factory', async () => {
    const applicationPool = createPostgresPool(harness.databaseUrl);
    try {
      const timezone = await applicationPool.query<{ TimeZone: string }>(
        'SHOW TimeZone',
      );
      expect(timezone.rows[0]?.TimeZone).toBe('UTC');
    } finally {
      await applicationPool.end();
    }
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
        constraint: 'api_keys_pkey',
      },
    );
  });

  it('rejects each projects and api_keys CHECK constraint independently', async () => {
    const projectId = randomUUID();
    await expectConstraint(
      'INSERT INTO projects (id, name, daily_quota_units) VALUES ($1::uuid, $2, $3)',
      [projectId, ' Project ', 1],
      'projects_name_ck',
    );
    await expectConstraint(
      'INSERT INTO projects (id, name, daily_quota_units) VALUES ($1::uuid, $2, $3)',
      [randomUUID(), 'Project', 0],
      'projects_daily_quota_units_ck',
    );

    const validProjectId = await insertProject();
    const keyId = randomUUID();
    const base = [keyId, validProjectId];
    await expectConstraint(
      `INSERT INTO api_keys (id, project_id, name, prefix, secret_digest, scopes)
       VALUES ($1::uuid, $2::uuid, ' key ', 'mq_' || $1::text, decode(repeat('ab', 32), 'hex'), ARRAY['usage:write'])`,
      base,
      'api_keys_name_ck',
    );
    await expectConstraint(
      `INSERT INTO api_keys (id, project_id, name, prefix, secret_digest, scopes)
       VALUES ($1::uuid, $2::uuid, 'key', 'wrong', decode(repeat('ab', 32), 'hex'), ARRAY['usage:write'])`,
      base,
      'api_keys_prefix_ck',
    );
    await expectConstraint(
      `INSERT INTO api_keys (id, project_id, name, prefix, secret_digest, scopes)
       VALUES ($1::uuid, $2::uuid, 'key', 'mq_' || $1::text, decode(repeat('ab', 31), 'hex'), ARRAY['usage:write'])`,
      base,
      'api_keys_secret_digest_ck',
    );
    await expectConstraint(
      `INSERT INTO api_keys (id, project_id, name, prefix, secret_digest, scopes)
       VALUES ($1::uuid, $2::uuid, 'key', 'mq_' || $1::text, decode(repeat('ab', 32), 'hex'), ARRAY[['usage:write']])`,
      base,
      'api_keys_scopes_dimension_ck',
    );
    await expectConstraint(
      `INSERT INTO api_keys (id, project_id, name, prefix, secret_digest, scopes)
       VALUES ($1::uuid, $2::uuid, 'key', 'mq_' || $1::text, decode(repeat('ab', 32), 'hex'), ARRAY[]::text[])`,
      base,
      'api_keys_scopes_cardinality_ck',
    );
    await expectConstraint(
      `INSERT INTO api_keys (id, project_id, name, prefix, secret_digest, scopes)
       VALUES ($1::uuid, $2::uuid, 'key', 'mq_' || $1::text, decode(repeat('ab', 32), 'hex'), ARRAY['invalid'])`,
      base,
      'api_keys_scopes_allowlist_ck',
    );
    await expectConstraint(
      `INSERT INTO api_keys (id, project_id, name, prefix, secret_digest, scopes, status, revoked_at)
       VALUES ($1::uuid, $2::uuid, 'key', 'mq_' || $1::text, decode(repeat('ab', 32), 'hex'), ARRAY['usage:write'], 'REVOKED', NULL)`,
      base,
      'api_keys_status_revoked_at_ck',
    );
  });

  it('rejects each usage_events, daily_usage, and audit_logs CHECK constraint independently', async () => {
    const projectId = await insertProject();
    const keyId = await insertApiKey(projectId);
    const receivedAt = '2026-08-12T12:00:00.000Z';
    const usageDate = '2026-08-12';
    const usage = `INSERT INTO usage_events
      (project_id, api_key_id, idempotency_key, payload_hash, usage_date, units, decision, response_status, quota_limit_units, quota_remaining_units, quota_reset_at, received_at, finalized_at)
      VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5::date, $6, $7::usage_decision, $8, $9, $10, $11::timestamptz, $12::timestamptz, $13::timestamptz)`;
    const pending = (overrides: unknown[] = []) => [
      projectId,
      keyId,
      randomUUID(),
      Buffer.alloc(32),
      usageDate,
      1,
      'PENDING',
      null,
      null,
      null,
      null,
      receivedAt,
      null,
      ...overrides,
    ];

    await expectConstraint(
      usage,
      pending().map((value, index) =>
        index === 2 ? '00000000-0000-1000-8000-000000000000' : value,
      ),
      'usage_events_idempotency_key_version_ck',
    );
    await expectConstraint(
      usage,
      pending().map((value, index) => (index === 3 ? Buffer.alloc(31) : value)),
      'usage_events_payload_hash_ck',
    );
    await expectConstraint(
      usage,
      pending().map((value, index) => (index === 5 ? 0 : value)),
      'usage_events_units_ck',
    );
    await expectConstraint(
      usage,
      pending().map((value, index) => (index === 4 ? '2026-08-11' : value)),
      'usage_events_usage_date_ck',
    );
    await expectConstraint(
      usage,
      pending().map((value, index) => (index === 6 ? 'ACCEPTED' : value)),
      'usage_events_decision_snapshot_ck',
    );
    await expectConstraint(
      usage,
      [
        projectId,
        keyId,
        randomUUID(),
        Buffer.alloc(32),
        usageDate,
        1,
        'ACCEPTED',
        200,
        0,
        0,
        '2026-08-13T00:00:00.000Z',
        receivedAt,
        receivedAt,
      ],
      'usage_events_quota_snapshot_ck',
    );
    await expectConstraint(
      usage,
      [
        projectId,
        keyId,
        randomUUID(),
        Buffer.alloc(32),
        usageDate,
        1,
        'ACCEPTED',
        200,
        1,
        0,
        '2026-08-13T00:00:00.000Z',
        receivedAt,
        '2026-08-11T12:00:00.000Z',
      ],
      'usage_events_finalized_at_ck',
    );
    await expectConstraint(
      usage,
      [
        projectId,
        keyId,
        randomUUID(),
        Buffer.alloc(32),
        usageDate,
        1,
        'ACCEPTED',
        200,
        1,
        0,
        '2026-08-14T00:00:00.000Z',
        receivedAt,
        receivedAt,
      ],
      'usage_events_quota_reset_at_ck',
    );

    await expectConstraint(
      `INSERT INTO daily_usage (project_id, usage_date, used_units, limit_units)
       VALUES ($1::uuid, '2026-08-12', 0, 0)`,
      [projectId],
      'daily_usage_limit_units_ck',
    );
    await expectConstraint(
      `INSERT INTO daily_usage (project_id, usage_date, used_units, limit_units)
       VALUES ($1::uuid, '2026-08-12', 2, 1)`,
      [projectId],
      'daily_usage_used_units_ck',
    );

    await expectConstraint(
      `INSERT INTO audit_logs (project_id, action, request_id, metadata)
       VALUES ($1::uuid, 'PROJECT_CREATED', $2::uuid, '[]'::jsonb)`,
      [projectId, randomUUID()],
      'audit_logs_metadata_ck',
    );
    await expectConstraint(
      `INSERT INTO audit_logs (project_id, action, request_id, metadata)
       VALUES ($1::uuid, 'API_KEY_CREATED', $2::uuid, '{}'::jsonb)`,
      [projectId, randomUUID()],
      'audit_logs_action_keys_ck',
    );
  });

  it('rejects every independently testable foreign key and unique constraint', async () => {
    const projectId = await insertProject('One');
    const otherProjectId = await insertProject('Two');
    const keyId = await insertApiKey(projectId);
    const otherKeyId = await insertApiKey(otherProjectId);

    await expect(
      pool.query(
        `INSERT INTO api_keys (id, project_id, name, prefix, secret_digest, scopes)
         VALUES ($1::uuid, $2::uuid, 'key', 'mq_' || $1::text, decode(repeat('ab', 32), 'hex'), ARRAY['usage:write'])`,
        [randomUUID(), randomUUID()],
      ),
    ).rejects.toMatchObject({
      code: '23503',
      constraint: 'api_keys_project_fk',
    });
    await expect(
      pool.query(
        `INSERT INTO usage_events (project_id, api_key_id, idempotency_key, payload_hash, usage_date, units, received_at)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4, '2026-08-12', 1, '2026-08-12T12:00:00.000Z')`,
        [randomUUID(), keyId, randomUUID(), Buffer.alloc(32)],
      ),
    ).rejects.toMatchObject({
      code: '23503',
      constraint: 'usage_events_project_fk',
    });
    await expect(
      pool.query(
        `INSERT INTO usage_events (project_id, api_key_id, idempotency_key, payload_hash, usage_date, units, received_at)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4, '2026-08-12', 1, '2026-08-12T12:00:00.000Z')`,
        [projectId, otherKeyId, randomUUID(), Buffer.alloc(32)],
      ),
    ).rejects.toMatchObject({
      code: '23503',
      constraint: 'usage_events_project_api_key_fk',
    });
    await expect(
      pool.query(
        `INSERT INTO daily_usage (project_id, usage_date, used_units, limit_units)
         VALUES ($1::uuid, '2026-08-12', 0, 1)`,
        [randomUUID()],
      ),
    ).rejects.toMatchObject({
      code: '23503',
      constraint: 'daily_usage_project_fk',
    });
    await expect(
      pool.query(
        `INSERT INTO audit_logs (project_id, action, request_id, metadata)
         VALUES ($1::uuid, 'PROJECT_CREATED', $2::uuid, '{}'::jsonb)`,
        [randomUUID(), randomUUID()],
      ),
    ).rejects.toMatchObject({
      code: '23503',
      constraint: 'audit_logs_project_fk',
    });
    await expect(
      pool.query(
        `INSERT INTO audit_logs (project_id, actor_key_id, resource_api_key_id, action, request_id)
         VALUES ($1::uuid, $2::uuid, $3::uuid, 'API_KEY_CREATED', $4::uuid)`,
        [projectId, otherKeyId, keyId, randomUUID()],
      ),
    ).rejects.toMatchObject({
      code: '23503',
      constraint: 'audit_logs_project_actor_key_fk',
    });
    await expect(
      pool.query(
        `INSERT INTO audit_logs (project_id, actor_key_id, resource_api_key_id, action, request_id)
         VALUES ($1::uuid, $2::uuid, $3::uuid, 'API_KEY_CREATED', $4::uuid)`,
        [projectId, keyId, otherKeyId, randomUUID()],
      ),
    ).rejects.toMatchObject({
      code: '23503',
      constraint: 'audit_logs_project_resource_api_key_fk',
    });

    await pool.query(
      `INSERT INTO usage_events (project_id, api_key_id, idempotency_key, payload_hash, usage_date, units, received_at)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4, '2026-08-12', 1, '2026-08-12T12:00:00.000Z')`,
      [
        projectId,
        keyId,
        'd9428888-122b-4f6f-89af-7db6ef06e2d3',
        Buffer.alloc(32),
      ],
    );
    await expect(
      pool.query(
        `INSERT INTO usage_events (project_id, api_key_id, idempotency_key, payload_hash, usage_date, units, received_at)
         VALUES ($1::uuid, $2::uuid, 'd9428888-122b-4f6f-89af-7db6ef06e2d3', $3, '2026-08-12', 1, '2026-08-12T12:00:00.000Z')`,
        [projectId, keyId, Buffer.alloc(32)],
      ),
    ).rejects.toMatchObject({
      code: '23505',
      constraint: 'usage_events_project_idempotency_key_uq',
    });
  });
});

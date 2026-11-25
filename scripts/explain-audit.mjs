import { randomBytes, randomUUID } from 'node:crypto';
import { cpus, platform, release } from 'node:os';
import { pathToFileURL } from 'node:url';
import pg from 'pg';

const rowCount = 10_000;
const pageSize = 50;

function extractPlan(node, names = []) {
  if (node['Index Name']) names.push(node['Index Name']);
  for (const child of node.Plans ?? []) extractPlan(child, names);
  return names;
}

function containsLargeSequentialScan(node) {
  if (node['Node Type'] === 'Seq Scan' && (node['Plan Rows'] ?? 0) >= 1_000) {
    return true;
  }
  return (node.Plans ?? []).some(containsLargeSequentialScan);
}

async function explain(client, sql, values) {
  const result = await client.query(
    `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${sql}`,
    values,
  );
  const plan = result.rows[0]['QUERY PLAN'][0];
  const indexes = extractPlan(plan.Plan);
  if (!indexes.includes('audit_logs_project_cursor_idx')) {
    throw new Error('Expected audit_logs_project_cursor_idx in query plan.');
  }
  if (containsLargeSequentialScan(plan.Plan)) {
    throw new Error('Large sequential scan detected in audit pagination plan.');
  }
  return plan;
}

export async function runAuditExplain(databaseUrl = process.env.DATABASE_URL) {
  if (!databaseUrl) throw new Error('DATABASE_URL is required.');
  const commit = process.env.COMMIT_SHA;
  if (!commit || !/^[0-9a-f]{7,64}$/.test(commit)) {
    throw new Error('COMMIT_SHA is required for explain provenance.');
  }
  const client = new pg.Client({ connectionString: databaseUrl });
  const projectId = randomUUID();
  const requestNamespace = randomBytes(6).toString('hex');
  await client.connect();
  try {
    const projectInsert = await client.query(
      'INSERT INTO projects (id, name, daily_quota_units) VALUES ($1, $2, 1000000000)',
      [projectId, `explain-${requestNamespace}`],
    );
    if (projectInsert.rowCount !== 1) {
      throw new Error('Expected one owned project fixture.');
    }
    const auditInsert = await client.query(
      `INSERT INTO audit_logs (id, project_id, action, request_id, metadata, created_at)
       SELECT md5($2::text || ':audit:' || sequence::text)::uuid,
              $1::uuid,
              'PROJECT_CREATED',
              md5($2::text || ':request:' || sequence::text)::uuid,
              jsonb_build_object(
                'projectName', $2::text,
                'dailyQuotaUnits', 1000000000,
                'initialApiKeyId', md5($2::text || ':key:' || sequence::text)::uuid
              ),
              '2026-01-01T00:00:00Z'::timestamptz + (sequence * interval '1 millisecond')
       FROM generate_series(1, $3::integer) AS sequence`,
      [projectId, `explain-${requestNamespace}`, rowCount],
    );
    if (auditInsert.rowCount !== rowCount) {
      throw new Error(
        `Expected ${rowCount} owned audit rows, inserted ${auditInsert.rowCount}.`,
      );
    }
    await client.query('ANALYZE audit_logs');
    const firstSql = `SELECT id, project_id, actor_key_id, action, resource_api_key_id, request_id, metadata, created_at
      FROM audit_logs WHERE project_id = $1::uuid
      ORDER BY created_at DESC, id DESC LIMIT ${pageSize}`;
    const cursor = await client.query(
      `SELECT created_at, id FROM audit_logs WHERE project_id = $1::uuid
       ORDER BY created_at DESC, id DESC OFFSET 4999 LIMIT 1`,
      [projectId],
    );
    if (cursor.rowCount !== 1)
      throw new Error('Middle cursor fixture is missing.');
    const middleSql = `SELECT id, project_id, actor_key_id, action, resource_api_key_id, request_id, metadata, created_at
      FROM audit_logs WHERE project_id = $1::uuid AND (created_at, id) < ($2::timestamptz, $3::uuid)
      ORDER BY created_at DESC, id DESC LIMIT ${pageSize}`;
    return {
      configuration: { pageSize, rowCount },
      environment: {
        commit,
        cpuLogicalCount: cpus().length,
        node: process.version,
        os: `${platform()} ${release()}`,
        postgres: (await client.query('SHOW server_version')).rows[0]
          .server_version,
        recordedAt: new Date().toISOString(),
      },
      firstPage: await explain(client, firstSql, [projectId]),
      middlePage: await explain(client, middleSql, [
        projectId,
        cursor.rows[0].created_at,
        cursor.rows[0].id,
      ]),
    };
  } finally {
    try {
      await client.query('DELETE FROM audit_logs WHERE project_id = $1::uuid', [
        projectId,
      ]);
      await client.query('DELETE FROM projects WHERE id = $1::uuid', [
        projectId,
      ]);
      await client.query('ANALYZE audit_logs');
    } finally {
      await client.end();
    }
  }
}

async function main() {
  const report = await runAuditExplain();
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  await main();
}

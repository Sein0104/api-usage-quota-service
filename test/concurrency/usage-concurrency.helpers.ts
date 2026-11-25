import { randomUUID } from 'node:crypto';
import { Buffer } from 'node:buffer';
import type { Pool } from 'pg';
import type { AuthenticatedApiKey } from '../../src/api-keys/auth/authenticated-api-key.js';
import { PrismaService } from '../../src/database/prisma.service.js';
import { UsageRepository } from '../../src/usage/usage.repository.js';
import { UsageService } from '../../src/usage/usage.service.js';
import { IdempotencyRetry } from '../../src/usage/idempotency-retry.js';
import { quotaTime } from '../../src/usage/domain/quota-time.js';
import { MetricsService } from '../../src/observability/metrics.service.js';

export async function createUsageActor(
  pool: Pool,
  quota: number,
): Promise<AuthenticatedApiKey> {
  const projectId = randomUUID();
  const id = randomUUID();
  await pool.query(
    `INSERT INTO projects (id, name, daily_quota_units) VALUES ($1, $2, $3)`,
    [projectId, `usage-concurrency-${projectId}`, quota],
  );
  await pool.query(
    `INSERT INTO api_keys
       (id, project_id, name, prefix, secret_digest, scopes)
     VALUES ($1, $2, 'writer', $3, $4, $5)`,
    [id, projectId, `mq_${id}`, Buffer.alloc(32, 3), ['usage:write']],
  );
  return { id, projectId, scopes: ['usage:write'] };
}

export function usageService(prisma: PrismaService): UsageService {
  return new UsageService(
    prisma,
    new UsageRepository(),
    new IdempotencyRetry(),
    quotaTime,
    new MetricsService(),
  );
}

export function concurrently<T>(operations: readonly (() => Promise<T>)[]) {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const promises = operations.map(async (operation) => {
    await gate;
    return operation();
  });
  release();
  return Promise.allSettled(promises);
}

export function ingest(
  service: UsageService,
  actor: AuthenticatedApiKey,
  idempotencyKey: string,
  units: number,
) {
  return service.ingest(actor, { units }, idempotencyKey, {
    receivedAt: new Date('2026-08-11T12:00:00.000Z'),
    requestId: randomUUID(),
  });
}

import { Injectable } from '@nestjs/common';
import type { Buffer } from 'node:buffer';
import { Prisma, type UsageDecision } from '../generated/prisma/client.js';

export interface InsertPendingUsage {
  apiKeyId: string;
  idempotencyKey: string;
  payloadHash: Buffer;
  projectId: string;
  receivedAt: Date;
  units: bigint;
  usageDate: string;
}

export interface StoredUsageEvent {
  decision: UsageDecision;
  eventId: string;
  payloadHash: Uint8Array;
  quotaLimit: bigint | null;
  quotaRemaining: bigint | null;
  quotaResetAt: Date | null;
  responseStatus: number | null;
  units: bigint;
  usageDate: string;
}

export interface DailyQuotaSnapshot {
  limit: bigint;
  used: bigint;
}

export interface FinalizeUsage {
  decision: Exclude<UsageDecision, 'PENDING'>;
  eventId: string;
  limit: bigint;
  receivedAt: Date;
  remaining: bigint;
  resetAt: Date;
  responseStatus: 200 | 429;
}

@Injectable()
export class UsageRepository {
  async insertPending(
    tx: Prisma.TransactionClient,
    input: InsertPendingUsage,
  ): Promise<string | null> {
    const rows = await tx.$queryRaw<{ id: string }[]>`
      INSERT INTO usage_events (
        project_id, api_key_id, idempotency_key, payload_hash,
        usage_date, units, decision, received_at
      ) VALUES (
        ${input.projectId}::uuid, ${input.apiKeyId}::uuid,
        ${input.idempotencyKey}::uuid, ${input.payloadHash},
        ${input.usageDate}::date, ${input.units},
        'PENDING'::usage_decision, ${input.receivedAt}
      )
      ON CONFLICT (project_id, idempotency_key) DO NOTHING
      RETURNING id
    `;
    return rows[0]?.id ?? null;
  }

  async findByIdempotencyKey(
    tx: Prisma.TransactionClient,
    projectId: string,
    idempotencyKey: string,
  ): Promise<StoredUsageEvent | null> {
    const rows = await tx.$queryRaw<StoredUsageEvent[]>`
      SELECT
        id AS "eventId",
        payload_hash AS "payloadHash",
        usage_date::text AS "usageDate",
        units,
        decision,
        response_status AS "responseStatus",
        quota_limit_units AS "quotaLimit",
        quota_remaining_units AS "quotaRemaining",
        quota_reset_at AS "quotaResetAt"
      FROM usage_events
      WHERE project_id = ${projectId}::uuid
        AND idempotency_key = ${idempotencyKey}::uuid
    `;
    return rows[0] ?? null;
  }

  async createDailyUsage(
    tx: Prisma.TransactionClient,
    projectId: string,
    usageDate: string,
  ): Promise<void> {
    await tx.$executeRaw`
      INSERT INTO daily_usage (project_id, usage_date, used_units, limit_units)
      SELECT id, ${usageDate}::date, 0, daily_quota_units
      FROM projects
      WHERE id = ${projectId}::uuid
      ON CONFLICT (project_id, usage_date) DO NOTHING
    `;
  }

  async tryConsume(
    tx: Prisma.TransactionClient,
    projectId: string,
    usageDate: string,
    units: bigint,
  ): Promise<DailyQuotaSnapshot | null> {
    const rows = await tx.$queryRaw<DailyQuotaSnapshot[]>`
      UPDATE daily_usage
      SET used_units = used_units + ${units}, updated_at = now()
      WHERE project_id = ${projectId}::uuid
        AND usage_date = ${usageDate}::date
        AND used_units + ${units} <= limit_units
      RETURNING used_units AS used, limit_units AS "limit"
    `;
    return rows[0] ?? null;
  }

  async lockDailyUsage(
    tx: Prisma.TransactionClient,
    projectId: string,
    usageDate: string,
  ): Promise<DailyQuotaSnapshot | null> {
    const rows = await tx.$queryRaw<DailyQuotaSnapshot[]>`
      SELECT used_units AS used, limit_units AS "limit"
      FROM daily_usage
      WHERE project_id = ${projectId}::uuid
        AND usage_date = ${usageDate}::date
      FOR UPDATE
    `;
    return rows[0] ?? null;
  }

  async finalize(
    tx: Prisma.TransactionClient,
    projectId: string,
    input: FinalizeUsage,
  ): Promise<StoredUsageEvent | null> {
    const rows = await tx.$queryRaw<StoredUsageEvent[]>`
      UPDATE usage_events
      SET
        decision = ${input.decision}::usage_decision,
        response_status = ${input.responseStatus},
        quota_limit_units = ${input.limit},
        quota_remaining_units = ${input.remaining},
        quota_reset_at = ${input.resetAt},
        finalized_at = GREATEST(now(), ${input.receivedAt})
      WHERE id = ${input.eventId}::uuid
        AND project_id = ${projectId}::uuid
        AND decision = 'PENDING'::usage_decision
      RETURNING
        id AS "eventId",
        payload_hash AS "payloadHash",
        usage_date::text AS "usageDate",
        units,
        decision,
        response_status AS "responseStatus",
        quota_limit_units AS "quotaLimit",
        quota_remaining_units AS "quotaRemaining",
        quota_reset_at AS "quotaResetAt"
    `;
    return rows[0] ?? null;
  }
}

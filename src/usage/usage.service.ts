import { Injectable } from '@nestjs/common';
import { Buffer } from 'node:buffer';
import { isDatabaseDependencyError } from '../common/database/dependency-error.js';
import { ProblemCode } from '../common/http/problem-code.js';
import { ProblemException } from '../common/http/problem.exception.js';
import type { RequestContext } from '../common/http/request-context.js';
import { Prisma, UsageDecision } from '../generated/prisma/client.js';
import { PrismaService } from '../database/prisma.service.js';
import type { AuthenticatedApiKey } from '../api-keys/auth/authenticated-api-key.js';
import { payloadHash } from './domain/payload-hash.js';
import { quotaTime } from './domain/quota-time.js';
import type { UsageTerminalResult } from './domain/usage-terminal-result.js';
import { UsageRepository, type StoredUsageEvent } from './usage.repository.js';

export interface CreateUsageEventCommand {
  units: number;
}

function validationError(): ProblemException {
  return new ProblemException({
    code: ProblemCode.VALIDATION_ERROR,
    detail: 'Request validation failed.',
    status: 400,
    title: 'Validation failed',
  });
}

function terminal(record: StoredUsageEvent): UsageTerminalResult {
  if (
    record.decision === UsageDecision.PENDING ||
    record.responseStatus === null ||
    record.quotaLimit === null ||
    record.quotaRemaining === null ||
    record.quotaResetAt === null
  ) {
    throw new Error('Committed PENDING usage event invariant violated.');
  }
  if (
    (record.decision === UsageDecision.ACCEPTED &&
      record.responseStatus !== 200) ||
    (record.decision === UsageDecision.QUOTA_EXCEEDED &&
      record.responseStatus !== 429)
  ) {
    throw new Error('Stored usage terminal result invariant violated.');
  }
  return {
    decision: record.decision,
    eventId: record.eventId,
    quota: {
      limit: record.quotaLimit,
      remaining: record.quotaRemaining,
      resetAt: record.quotaResetAt,
    },
    responseStatus: record.responseStatus as 200 | 429,
    units: record.units,
    usageDate: record.usageDate,
  };
}

@Injectable()
export class UsageService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly repository: UsageRepository,
  ) {}

  async ingest(
    actor: AuthenticatedApiKey,
    command: CreateUsageEventCommand,
    idempotencyKey: string,
    context: RequestContext,
  ): Promise<UsageTerminalResult> {
    if (
      !Number.isInteger(command.units) ||
      command.units < 1 ||
      command.units > 10_000
    ) {
      throw validationError();
    }
    const hash = payloadHash(command.units);
    const time = quotaTime(context.receivedAt);

    try {
      return await this.prisma.$transaction(
        async (tx) => {
          const eventId = await this.repository.insertPending(tx, {
            apiKeyId: actor.id,
            idempotencyKey,
            payloadHash: hash,
            projectId: actor.projectId,
            receivedAt: context.receivedAt,
            units: BigInt(command.units),
            usageDate: time.usageDate,
          });

          if (eventId === null) {
            const existing = await this.repository.findByIdempotencyKey(
              tx,
              actor.projectId,
              idempotencyKey,
            );
            if (existing === null) {
              throw new Error('Conflicting usage event was not visible.');
            }
            if (!Buffer.from(existing.payloadHash).equals(hash)) {
              throw new ProblemException({
                code: ProblemCode.IDEMPOTENCY_KEY_REUSED,
                detail:
                  'The idempotency key was already used with another payload.',
                status: 409,
                title: 'Idempotency key reused',
              });
            }
            return terminal(existing);
          }

          await this.repository.createDailyUsage(
            tx,
            actor.projectId,
            time.usageDate,
          );
          const consumed = await this.repository.tryConsume(
            tx,
            actor.projectId,
            time.usageDate,
            BigInt(command.units),
          );
          const snapshot =
            consumed ??
            (await this.repository.lockDailyUsage(
              tx,
              actor.projectId,
              time.usageDate,
            ));
          if (snapshot === null) {
            throw new Error(
              'Authenticated project quota row invariant violated.',
            );
          }
          const accepted = consumed !== null;
          const finalized = await this.repository.finalize(
            tx,
            actor.projectId,
            {
              decision: accepted
                ? UsageDecision.ACCEPTED
                : UsageDecision.QUOTA_EXCEEDED,
              eventId,
              limit: snapshot.limit,
              receivedAt: context.receivedAt,
              remaining: snapshot.limit - snapshot.used,
              resetAt: time.resetAt,
              responseStatus: accepted ? 200 : 429,
            },
          );
          if (finalized === null) {
            throw new Error('Usage event finalization invariant violated.');
          }
          return terminal(finalized);
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted },
      );
    } catch (error) {
      if (
        error instanceof ProblemException ||
        !isDatabaseDependencyError(error)
      ) {
        throw error;
      }
      throw new ProblemException({
        code: ProblemCode.DEPENDENCY_UNAVAILABLE,
        detail: 'A required dependency is temporarily unavailable.',
        status: 503,
        title: 'Dependency unavailable',
      });
    }
  }
}

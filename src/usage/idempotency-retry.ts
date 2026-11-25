import { setTimeout as delay } from 'node:timers/promises';
import { ProblemCode } from '../common/http/problem-code.js';
import { ProblemException } from '../common/http/problem.exception.js';

const RETRY_DELAY_MS = 10;
const MAX_RETRIES = 3;

export interface IdempotencyRetryScheduler {
  wait(milliseconds: number): Promise<void>;
}

const systemScheduler: IdempotencyRetryScheduler = {
  async wait(milliseconds): Promise<void> {
    await delay(milliseconds);
  },
};

export class IdempotencyConflictNotVisibleError extends Error {
  constructor() {
    super('Conflicting usage event was not visible.');
    this.name = 'IdempotencyConflictNotVisibleError';
  }
}

export class IdempotencyRetry {
  constructor(
    private readonly scheduler: IdempotencyRetryScheduler = systemScheduler,
  ) {}

  async execute<T>(operation: () => Promise<T>): Promise<T> {
    for (let retryCount = 0; ; retryCount += 1) {
      try {
        return await operation();
      } catch (error) {
        if (!(error instanceof IdempotencyConflictNotVisibleError)) {
          throw error;
        }
        if (retryCount === MAX_RETRIES) {
          throw new ProblemException({
            code: ProblemCode.CONCURRENT_REQUEST_RETRY_EXHAUSTED,
            detail: 'The concurrent idempotency request could not be resolved.',
            status: 503,
            title: 'Concurrent request retry exhausted',
          });
        }
        await this.scheduler.wait(RETRY_DELAY_MS);
      }
    }
  }
}

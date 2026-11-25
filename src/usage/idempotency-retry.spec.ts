import { jest } from '@jest/globals';
import { ProblemCode } from '../common/http/problem-code.js';
import { ProblemException } from '../common/http/problem.exception.js';
import {
  IdempotencyConflictNotVisibleError,
  IdempotencyRetry,
  type IdempotencyRetryScheduler,
} from './idempotency-retry.js';

describe('IdempotencyRetry', () => {
  function fixture() {
    const wait = jest.fn(async () => undefined);
    const scheduler: IdempotencyRetryScheduler = { wait };
    return { retry: new IdempotencyRetry(scheduler), wait };
  }

  it('retries the invisible-conflict sentinel three times with a fixed 10ms delay', async () => {
    const { retry, wait } = fixture();
    let attempts = 0;

    await expect(
      retry.execute(async () => {
        attempts += 1;
        if (attempts < 4) throw new IdempotencyConflictNotVisibleError();
        return 'terminal';
      }),
    ).resolves.toBe('terminal');
    expect(attempts).toBe(4);
    expect(wait.mock.calls).toEqual([[10], [10], [10]]);
  });

  it('maps a fourth invisible conflict to the dedicated 503 without a fourth wait', async () => {
    const { retry, wait } = fixture();
    let attempts = 0;

    await expect(
      retry.execute(async () => {
        attempts += 1;
        throw new IdempotencyConflictNotVisibleError();
      }),
    ).rejects.toMatchObject({
      problem: {
        code: ProblemCode.CONCURRENT_REQUEST_RETRY_EXHAUSTED,
        status: 503,
      },
    });
    expect(attempts).toBe(4);
    expect(wait).toHaveBeenCalledTimes(3);
  });

  it.each([
    new ProblemException({
      code: ProblemCode.IDEMPOTENCY_KEY_REUSED,
      detail: 'conflict',
      status: 409,
      title: 'conflict',
    }),
    { code: 'P1001' },
    {
      code: 'P2010',
      meta: { driverAdapterError: { cause: { originalCode: '23514' } } },
    },
    new Error('ordinary failure'),
  ])('never retries a non-sentinel failure', async (failure) => {
    const { retry, wait } = fixture();
    let attempts = 0;

    await expect(
      retry.execute(async () => {
        attempts += 1;
        throw failure;
      }),
    ).rejects.toBe(failure);
    expect(attempts).toBe(1);
    expect(wait).not.toHaveBeenCalled();
  });
});

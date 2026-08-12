import { jest } from '@jest/globals';
import {
  acquireTransactionBarrier,
  observeBarrierAndSettle,
  type TransactionBarrierPool,
  type TransactionBarrier,
} from './concurrency-barrier.js';

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolver) => {
    resolve = resolver;
  });
  return { promise, resolve };
}

describe('observeBarrierAndSettle', () => {
  it('settles started operations after rollback before rethrowing the observer error', async () => {
    const events: string[] = [];
    const blocked = deferred<string>();
    const operation = blocked.promise.then((value) => {
      events.push('operation-settled');
      return value;
    });
    const barrier: TransactionBarrier = {
      query: jest.fn(async (statement: string) => {
        events.push(statement);
        blocked.resolve('released');
      }),
      release: jest.fn(() => events.push('connection-released')),
    };
    const observerError = new Error('forced observer failure');

    let received: unknown;
    try {
      await observeBarrierAndSettle(barrier, [operation], async () => {
        events.push('observe');
        throw observerError;
      });
    } catch (error) {
      received = error;
      events.push('error-rethrown');
    }

    expect(received).toBe(observerError);
    expect(barrier.query).toHaveBeenCalledTimes(1);
    expect(barrier.query).toHaveBeenCalledWith('ROLLBACK');
    expect(barrier.release).toHaveBeenCalledTimes(1);
    expect(events.indexOf('operation-settled')).toBeGreaterThan(
      events.indexOf('ROLLBACK'),
    );
    expect(events.indexOf('error-rethrown')).toBeGreaterThan(
      events.indexOf('operation-settled'),
    );
    expect(events.indexOf('error-rethrown')).toBeGreaterThan(
      events.indexOf('connection-released'),
    );
  });

  it('commits once and returns settled outcomes on the success path', async () => {
    const barrier: TransactionBarrier = {
      query: jest.fn(async () => undefined),
      release: jest.fn(),
    };

    const outcomes = await observeBarrierAndSettle(
      barrier,
      [Promise.resolve('done'), Promise.reject(new Error('operation failed'))],
      async () => undefined,
    );

    expect(barrier.query).toHaveBeenCalledTimes(1);
    expect(barrier.query).toHaveBeenCalledWith('COMMIT');
    expect(barrier.release).toHaveBeenCalledTimes(1);
    expect(outcomes).toEqual([
      { status: 'fulfilled', value: 'done' },
      { status: 'rejected', reason: expect.any(Error) },
    ]);
  });

  it.each([
    {
      label: 'observer takes precedence over rollback and release failures',
      observerError: new Error('observer'),
      transactionError: new Error('rollback'),
      releaseError: new Error('release'),
      expected: 'observer',
    },
    {
      label: 'commit failure takes precedence over release failure',
      transactionError: new Error('commit'),
      releaseError: new Error('release'),
      expected: 'commit',
    },
    {
      label: 'release failure is propagated after operations settle',
      releaseError: new Error('release'),
      expected: 'release',
    },
    {
      label:
        'non-Error transaction failure discards the connection with an Error',
      transactionError: 'rollback-string',
      releaseError: undefined,
      expected: 'rollback-string',
    },
  ])(
    '$label',
    async ({ observerError, transactionError, releaseError, expected }) => {
      const events: string[] = [];
      const blocked = deferred<void>();
      const operation = blocked.promise.then(() =>
        events.push('operation-settled'),
      );
      const barrier: TransactionBarrier = {
        query: jest.fn(async () => {
          if (transactionError !== undefined) throw transactionError;
        }),
        release: jest.fn((error?: Error | boolean) => {
          events.push(
            `released:${error instanceof Error ? error.message : String(error)}`,
          );
          blocked.resolve();
          if (releaseError !== undefined) throw releaseError;
        }),
      };

      let received: unknown;
      try {
        await observeBarrierAndSettle(barrier, [operation], async () => {
          if (observerError !== undefined) throw observerError;
        });
      } catch (error) {
        received = error;
        events.push('error-rethrown');
      }

      expect(received).toBeInstanceOf(Error);
      expect((received as Error).message).toBe(expected);
      expect(barrier.release).toHaveBeenCalledTimes(1);
      if (transactionError === undefined) {
        expect(barrier.release).toHaveBeenCalledWith();
      } else {
        expect(barrier.release).toHaveBeenCalledWith(expect.any(Error));
        expect(
          (jest.mocked(barrier.release).mock.calls[0][0] as Error).message,
        ).toBe(
          transactionError instanceof Error
            ? transactionError.message
            : String(transactionError),
        );
      }
      expect(events.indexOf('error-rethrown')).toBeGreaterThan(
        events.indexOf('operation-settled'),
      );
    },
  );

  it.each(['BEGIN', 'LOCK'])(
    'discards a client when %s setup fails',
    async (failurePoint) => {
      const setupError = new Error(`${failurePoint} failed`);
      const releaseError = new Error('release failed');
      const client: TransactionBarrier = {
        query: jest.fn(async (statement: string) => {
          if (
            failurePoint === 'BEGIN' ||
            statement.startsWith('SELECT id FROM projects')
          ) {
            throw setupError;
          }
        }),
        release: jest.fn(() => {
          throw releaseError;
        }),
      };
      const pool: TransactionBarrierPool = {
        connect: jest.fn(async () => client),
      };

      await expect(
        acquireTransactionBarrier(
          pool,
          'SELECT id FROM projects WHERE id = $1 FOR UPDATE',
          ['project-id'],
        ),
      ).rejects.toBe(setupError);
      expect(client.release).toHaveBeenCalledTimes(1);
      expect(client.release).toHaveBeenCalledWith(setupError);
    },
  );

  it('does not attempt release when pool.connect fails', async () => {
    const connectError = new Error('connect failed');
    const pool: TransactionBarrierPool = {
      connect: jest.fn(async () => {
        throw connectError;
      }),
    };

    await expect(
      acquireTransactionBarrier(pool, 'SELECT 1 FOR UPDATE', []),
    ).rejects.toBe(connectError);
  });
});

import { jest } from '@jest/globals';
import {
  observeBarrierAndSettle,
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
});

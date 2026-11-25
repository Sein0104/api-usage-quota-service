export interface TransactionBarrier {
  query(statement: string, values?: unknown[]): Promise<unknown>;
  release(error?: Error | boolean): void;
}

export interface TransactionBarrierPool {
  connect(): Promise<TransactionBarrier>;
}

function normalizeError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

export async function acquireTransactionBarrier(
  pool: TransactionBarrierPool,
  lockStatement: string,
  lockValues: unknown[],
): Promise<TransactionBarrier> {
  const barrier = await pool.connect();
  try {
    await barrier.query('BEGIN');
    await barrier.query(lockStatement, lockValues);
    return barrier;
  } catch (error) {
    const setupError = normalizeError(error);
    try {
      barrier.release(setupError);
    } catch {
      // The setup error is the root cause and the client has already been
      // marked for destruction; a release callback failure must not mask it.
    }
    throw setupError;
  }
}

export async function observeBarrierAndSettle(
  barrier: TransactionBarrier,
  operations: readonly Promise<unknown>[],
  observe: () => Promise<void>,
): Promise<PromiseSettledResult<unknown>[]> {
  let observerError: Error | undefined;
  try {
    await observe();
  } catch (error) {
    observerError = normalizeError(error);
  }

  let transactionError: Error | undefined;
  try {
    await barrier.query(observerError === undefined ? 'COMMIT' : 'ROLLBACK');
  } catch (error) {
    transactionError = normalizeError(error);
  }

  let releaseError: Error | undefined;
  try {
    if (transactionError !== undefined) barrier.release(transactionError);
    else barrier.release();
  } catch (error) {
    releaseError = normalizeError(error);
  }

  const outcomes = await Promise.allSettled(operations);
  if (observerError !== undefined) throw observerError;
  if (transactionError !== undefined) throw transactionError;
  if (releaseError !== undefined) throw releaseError;
  return outcomes;
}

export interface TransactionBarrier {
  query(statement: string): Promise<unknown>;
  release(): void;
}

export async function observeBarrierAndSettle(
  barrier: TransactionBarrier,
  operations: readonly Promise<unknown>[],
  observe: () => Promise<void>,
): Promise<PromiseSettledResult<unknown>[]> {
  let observerFailed = false;
  let observerError: unknown;
  try {
    await observe();
  } catch (error) {
    observerFailed = true;
    observerError = error;
  }

  let releaseFailed = false;
  let releaseError: unknown;
  try {
    await barrier.query(observerFailed ? 'ROLLBACK' : 'COMMIT');
  } catch (error) {
    releaseFailed = true;
    releaseError = error;
  } finally {
    barrier.release();
  }

  const outcomes = await Promise.allSettled(operations);
  if (observerFailed) throw observerError;
  if (releaseFailed) throw releaseError;
  return outcomes;
}

import type { Prisma } from '../../src/generated/prisma/client.js';
import {
  UsageRepository,
  type StoredUsageEvent,
} from '../../src/usage/usage.repository.js';

export class FinalizeThenFailUsageRepository extends UsageRepository {
  override async finalize(
    tx: Prisma.TransactionClient,
    projectId: string,
    input: Parameters<UsageRepository['finalize']>[2],
  ): Promise<StoredUsageEvent | null> {
    await super.finalize(tx, projectId, input);
    throw new Error('forced failure after usage finalization');
  }
}

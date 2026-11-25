import { Inject, Injectable, OnApplicationShutdown } from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';
import type { Pool } from 'pg';
import { PrismaClient } from '../generated/prisma/client.js';
import { PG_POOL } from './database.constants.js';

@Injectable()
export class PrismaService
  extends PrismaClient
  implements OnApplicationShutdown
{
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {
    // Let the pool's 3s acquisition deadline finish before Prisma gives up.
    // Prisma's default 2s maxWait otherwise rejects still-viable queued work.
    super({
      adapter: new PrismaPg(pool),
      transactionOptions: { maxWait: 5_000 },
    });
  }

  async onApplicationShutdown(): Promise<void> {
    await this.$disconnect();
    await this.pool.end();
  }
}

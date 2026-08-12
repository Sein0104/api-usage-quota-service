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
    // Prisma 7.9.1 accepts an externally owned pg.Pool. We own its shutdown here.
    super({ adapter: new PrismaPg(pool) });
  }

  async onApplicationShutdown(): Promise<void> {
    await this.$disconnect();
    await this.pool.end();
  }
}

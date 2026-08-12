import { Global, Module } from '@nestjs/common';
import { PG_POOL } from './database.constants.js';
import { MigrationStatusService } from './migration-status.service.js';
import { createPostgresPool } from './postgres-pool.provider.js';
import { PrismaService } from './prisma.service.js';

@Global()
@Module({
  exports: [PG_POOL, MigrationStatusService, PrismaService],
  providers: [
    { provide: PG_POOL, useFactory: createPostgresPool },
    MigrationStatusService,
    PrismaService,
  ],
})
export class DatabaseModule {}

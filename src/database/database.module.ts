import { Global, Module } from '@nestjs/common';
import { ENVIRONMENT } from '../config/environment.module.js';
import type { Environment } from '../config/environment.schema.js';
import { PG_POOL } from './database.constants.js';
import { MigrationStatusService } from './migration-status.service.js';
import { createPostgresPool } from './postgres-pool.provider.js';
import { PrismaService } from './prisma.service.js';

@Global()
@Module({
  exports: [PG_POOL, MigrationStatusService, PrismaService],
  providers: [
    {
      inject: [ENVIRONMENT],
      provide: PG_POOL,
      useFactory: (environment: Environment) =>
        createPostgresPool(environment.DATABASE_URL),
    },
    MigrationStatusService,
    PrismaService,
  ],
})
export class DatabaseModule {}

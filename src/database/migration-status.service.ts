import { Inject, Injectable } from '@nestjs/common';
import type { Pool } from 'pg';
import { EXPECTED_MIGRATIONS, PG_POOL } from './database.constants.js';

interface MigrationRow {
  finished_at: Date | null;
  migration_name: string;
  rolled_back_at: Date | null;
}

@Injectable()
export class MigrationStatusService {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  async isReady(): Promise<boolean> {
    try {
      const result = await this.pool.query<MigrationRow>(
        `SELECT migration_name, finished_at, rolled_back_at
         FROM public._prisma_migrations`,
      );
      const migrations = new Map(
        result.rows.map((migration) => [migration.migration_name, migration]),
      );

      const expectedMigrationsAreApplied = EXPECTED_MIGRATIONS.every((name) => {
        const migration = migrations.get(name);
        return (
          migration?.finished_at !== null && migration?.rolled_back_at === null
        );
      });
      const noMigrationFailedOrIsIncomplete = result.rows.every(
        (migration) =>
          migration.finished_at !== null && migration.rolled_back_at === null,
      );

      return expectedMigrationsAreApplied && noMigrationFailedOrIsIncomplete;
    } catch {
      return false;
    }
  }
}

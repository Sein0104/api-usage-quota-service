import { Pool } from 'pg';

export function createPostgresPool(databaseUrl: string): Pool {
  return new Pool({
    connectionString: databaseUrl,
    connectionTimeoutMillis: 3_000,
    idleTimeoutMillis: 30_000,
    max: 10,
    options: '-c TimeZone=UTC',
  });
}

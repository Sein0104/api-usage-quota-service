import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface PostgresTestHarness {
  databaseUrl: string;
  start(): Promise<void>;
  stop(): Promise<void>;
  migrate(): Promise<void>;
}

export function createPostgresTestHarness(): PostgresTestHarness {
  let container: StartedPostgreSqlContainer | undefined;
  let databaseUrl = '';

  return {
    get databaseUrl(): string {
      return databaseUrl;
    },
    async start(): Promise<void> {
      container = await new PostgreSqlContainer('postgres:18.0').start();
      databaseUrl = container.getConnectionUri();
    },
    async stop(): Promise<void> {
      await container?.stop();
      container = undefined;
    },
    async migrate(): Promise<void> {
      await execFileAsync(
        process.execPath,
        ['node_modules/prisma/build/index.js', 'migrate', 'deploy'],
        {
          env: { ...process.env, DATABASE_URL: databaseUrl },
        },
      );
    },
  };
}

import type { DynamicModule } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AppModule } from '../app.module.js';
import {
  API_KEY_PEPPER,
  SYSTEM_ADMIN_TOKEN,
} from '../common/security/security.tokens.js';
import { SystemAdminGuard } from '../system-admin/system-admin.guard.js';
import type { Environment } from './environment.schema.js';

const environment: Environment = {
  API_KEY_PEPPER: 'p'.repeat(43),
  DATABASE_URL: 'postgresql://postgres:postgres@localhost:5432/api_usage',
  LOG_LEVEL: 'info',
  METRICS_TOKEN: 'm'.repeat(43),
  NODE_ENV: 'test',
  PORT: 3000,
  SWAGGER_ENABLED: true,
  SYSTEM_ADMIN_TOKEN: 's'.repeat(43),
  TZ: 'UTC',
};

describe('AppModule configuration', () => {
  it('does not let a plain root module import activate system administrator authentication', async () => {
    const module = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    expect(() => module.get(SystemAdminGuard)).toThrow();
  });

  it('uses the validated environment supplied to the root dynamic module', async () => {
    const forRoot = (
      AppModule as unknown as {
        forRoot(value: Environment): DynamicModule;
      }
    ).forRoot;
    const module = await Test.createTestingModule({
      imports: [forRoot(environment)],
    }).compile();

    expect(module.get(SYSTEM_ADMIN_TOKEN)).toBe(environment.SYSTEM_ADMIN_TOKEN);
    expect(module.get(API_KEY_PEPPER)).toBe(environment.API_KEY_PEPPER);
  });
});

import type { Environment } from '../../src/config/environment.schema.js';

export function testEnvironment(
  overrides: Partial<Environment> = {},
): Environment {
  return {
    API_KEY_PEPPER: 'p'.repeat(43),
    DATABASE_URL: 'postgresql://postgres:postgres@localhost:5432/api_usage',
    LOG_LEVEL: 'info',
    METRICS_TOKEN: 'm'.repeat(43),
    NODE_ENV: 'test',
    PORT: 3000,
    SWAGGER_ENABLED: true,
    SYSTEM_ADMIN_TOKEN: 's'.repeat(43),
    TZ: 'UTC',
    ...overrides,
  };
}

import { validateEnvironment } from './environment.schema.js';
import { systemClock } from '../common/time/clock.js';

const requiredEnvironment = {
  NODE_ENV: 'test',
  PORT: '3000',
  DATABASE_URL: 'postgres://localhost:5432/api_usage',
  SYSTEM_ADMIN_TOKEN: 'a'.repeat(43),
  API_KEY_PEPPER: 'b'.repeat(43),
  METRICS_TOKEN: 'c'.repeat(43),
  LOG_LEVEL: 'info',
  TZ: 'UTC',
};

describe('validateEnvironment', () => {
  it('rejects an environment without a required secret', () => {
    const withoutAdminToken = {
      ...requiredEnvironment,
      SYSTEM_ADMIN_TOKEN: undefined,
    };

    expect(() => validateEnvironment(withoutAdminToken)).toThrow();
  });

  it.each([
    ['development', true],
    ['test', true],
    ['production', false],
  ] as const)(
    'defaults SWAGGER_ENABLED for %s',
    (nodeEnvironment, expected) => {
      expect(
        validateEnvironment({
          ...requiredEnvironment,
          NODE_ENV: nodeEnvironment,
        }).SWAGGER_ENABLED,
      ).toBe(expected);
    },
  );

  it.each([
    ['development', 'false', false],
    ['production', 'true', true],
  ] as const)(
    'uses an explicit SWAGGER_ENABLED override for %s',
    (nodeEnvironment, swaggerEnabled, expected) => {
      expect(
        validateEnvironment({
          ...requiredEnvironment,
          NODE_ENV: nodeEnvironment,
          SWAGGER_ENABLED: swaggerEnabled,
        }).SWAGGER_ENABLED,
      ).toBe(expected);
    },
  );
});

describe('systemClock', () => {
  it('returns the current time as a Date', () => {
    expect(systemClock.now()).toBeInstanceOf(Date);
  });
});

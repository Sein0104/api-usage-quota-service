import type { INestApplication } from '@nestjs/common';
import { beforeEach, jest } from '@jest/globals';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import request from 'supertest';
import { AppModule } from '../../src/app.module.js';
import { configureApplication } from '../../src/main.js';
import { cleanDatabase } from '../support/database-cleaner.js';
import { createPostgresTestHarness } from '../support/postgres-test-harness.js';
import { testEnvironment } from '../support/test-environment.js';

jest.setTimeout(120_000);

const systemAdminToken = 'a'.repeat(43);
const apiKeyPepper = 'b'.repeat(43);

describe('GET /v1/usage/daily', () => {
  const harness = createPostgresTestHarness();
  let app: INestApplication;
  let pool: Pool;
  let managerSecret: string;
  let noReadSecret: string;
  let projectId: string;

  beforeAll(async () => {
    await harness.start();
    await harness.migrate();
    pool = new Pool({ connectionString: harness.databaseUrl });
    const module = await Test.createTestingModule({
      imports: [
        AppModule.forRoot(
          testEnvironment({
            API_KEY_PEPPER: apiKeyPepper,
            DATABASE_URL: harness.databaseUrl,
            SYSTEM_ADMIN_TOKEN: systemAdminToken,
          }),
        ),
      ],
    }).compile();
    app = module.createNestApplication();
    configureApplication(app);
    await app.init();
  });

  beforeEach(async () => {
    await cleanDatabase(pool);
    const bootstrap = await request(app.getHttpServer())
      .post('/v1/admin/projects')
      .set('Authorization', `Bearer ${systemAdminToken}`)
      .send({ dailyQuotaUnits: 1000, name: `daily-${randomUUID()}` });
    managerSecret = bootstrap.body.secret as string;
    projectId = bootstrap.body.project.id as string;
    const noRead = await request(app.getHttpServer())
      .post('/v1/api-keys')
      .set('Authorization', `Bearer ${managerSecret}`)
      .send({ name: 'write-only', scopes: ['usage:write'] });
    noReadSecret = noRead.body.secret as string;
  });

  afterAll(async () => {
    await app?.close();
    await pool?.end();
    await harness.stop();
  });

  function get(path = '/v1/usage/daily') {
    return request(app.getHttpServer())
      .get(path)
      .set('Authorization', `Bearer ${managerSecret}`);
  }

  it('keeps authentication and scope ahead of strict query validation', async () => {
    const unauthorized = await request(app.getHttpServer()).get(
      '/v1/usage/daily?from=broken',
    );
    const forbidden = await request(app.getHttpServer())
      .get('/v1/usage/daily?from=broken')
      .set('Authorization', `Bearer ${noReadSecret}`);
    const invalid = await get('/v1/usage/daily?from=broken');

    expect(unauthorized).toMatchObject({
      status: 401,
      body: { code: 'INVALID_API_KEY', requestId: expect.any(String) },
    });
    expect(forbidden).toMatchObject({
      status: 403,
      body: { code: 'INSUFFICIENT_SCOPE', requestId: expect.any(String) },
    });
    expect(invalid).toMatchObject({
      status: 400,
      body: { code: 'VALIDATION_ERROR', requestId: expect.any(String) },
    });
  });

  it('returns only the actor tenant rows in ascending order with the exact contract', async () => {
    const otherId = randomUUID();
    await pool.query(
      `INSERT INTO projects (id, name, daily_quota_units)
       VALUES ($1, $2, 50)`,
      [otherId, `other-${randomUUID()}`],
    );
    await pool.query(
      `INSERT INTO daily_usage
         (project_id, usage_date, used_units, limit_units, updated_at)
       VALUES
         ($1, '2026-08-01', 2, 1000, '2026-08-01T11:00:00.456Z'),
         ($1, '2026-08-03', 0, 1000, '2026-08-03T09:00:00.789Z'),
         ($2, '2026-08-01', 40, 50, '2026-08-01T10:00:00.000Z')`,
      [projectId, otherId],
    );

    const response = await get('/v1/usage/daily?from=2026-08-01&to=2026-08-03');

    expect(response).toMatchObject({
      status: 200,
      body: {
        items: [
          {
            limitUnits: 1000,
            remainingUnits: 998,
            updatedAt: '2026-08-01T11:00:00.456Z',
            usageDate: '2026-08-01',
            usedUnits: 2,
          },
          {
            limitUnits: 1000,
            remainingUnits: 1000,
            updatedAt: '2026-08-03T09:00:00.789Z',
            usageDate: '2026-08-03',
            usedUnits: 0,
          },
        ],
      },
    });
    expect(Object.keys(response.body)).toEqual(['items']);
    expect(Object.keys(response.body.items[0]).sort()).toEqual([
      'limitUnits',
      'remainingUnits',
      'updatedAt',
      'usageDate',
      'usedUnits',
    ]);
    expect(response.headers['x-quota-limit']).toBeUndefined();
    expect(response.headers['x-quota-remaining']).toBeUndefined();
    expect(response.headers['x-quota-reset']).toBeUndefined();
  });

  it('accepts canonical uppercase and trailing routes at the 90-day boundary', async () => {
    for (const path of [
      '/v1/usage/daily?from=2024-01-01&to=2024-03-30',
      '/v1/USAGE/DAILY/?from=2024-02-29&to=2024-02-29',
      '/v1/usage/daily?from=0001-01-01&to=0001-01-01',
      '/v1/usage/daily?from=9999-12-31&to=9999-12-31',
    ]) {
      const response = await get(path);
      expect(response).toMatchObject({ status: 200, body: { items: [] } });
    }
  });

  it.each([
    '/v1/usage/daily',
    '/v1/usage/daily?from=&to=2026-08-01',
    '/v1/usage/daily?from=2026-08-01&to=',
    '/v1/usage/daily?from=2026-08-01&from=2026-08-02&to=2026-08-03',
    '/v1/usage/daily?from=2026-08-01&to=2026-08-02&extra=x',
    '/v1/usage/daily?from=2026-08-01T00:00:00.000Z&to=2026-08-02',
    '/v1/usage/daily?from=2023-02-29&to=2023-03-01',
    '/v1/usage/daily?from=2026-08-02&to=2026-08-01',
    '/v1/usage/daily?from=2024-01-01&to=2024-03-31',
  ])('rejects a non-canonical or invalid query: %s', async (path) => {
    const response = await get(path);
    expect(response).toMatchObject({
      status: 400,
      body: { code: 'VALIDATION_ERROR', requestId: expect.any(String) },
    });
    expect(response.body.requestId).toBe(response.headers['x-request-id']);
  });

  it('keeps wrong methods and usage descendants parser-before 404', async () => {
    for (const response of await Promise.all([
      request(app.getHttpServer()).post('/v1/usage/daily').send('{'),
      request(app.getHttpServer()).get('/v1/usage'),
      request(app.getHttpServer()).get('/v1/usage/daily/child'),
      request(app.getHttpServer()).delete('/v1/usage/other/child'),
    ])) {
      expect(response).toMatchObject({
        status: 404,
        body: { code: 'ROUTE_NOT_FOUND', requestId: expect.any(String) },
      });
      expect(response.headers['www-authenticate']).toBeUndefined();
    }
  });
});

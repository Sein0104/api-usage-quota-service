import type { INestApplication } from '@nestjs/common';
import { jest } from '@jest/globals';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../../src/app.module.js';
import { configureApplication } from '../../src/main.js';
import { createPostgresTestHarness } from '../support/postgres-test-harness.js';
import { testEnvironment } from '../support/test-environment.js';

jest.setTimeout(120_000);

const systemAdminToken = 'a'.repeat(43);
const apiKeyPepper = 'b'.repeat(43);
const metricsToken = 'c'.repeat(43);

describe('API key list, revoke, and rotation lifecycle', () => {
  const harness = createPostgresTestHarness();
  let app: INestApplication;
  let managerSecret: string;
  let managerId: string;

  beforeAll(async () => {
    await harness.start();
    await harness.migrate();
    const module = await Test.createTestingModule({
      imports: [
        AppModule.forRoot(
          testEnvironment({
            API_KEY_PEPPER: apiKeyPepper,
            DATABASE_URL: harness.databaseUrl,
            METRICS_TOKEN: metricsToken,
            SYSTEM_ADMIN_TOKEN: systemAdminToken,
          }),
        ),
      ],
    }).compile();
    app = module.createNestApplication();
    configureApplication(app);
    await app.init();

    const bootstrap = await request(app.getHttpServer())
      .post('/v1/admin/projects')
      .set('Authorization', `Bearer ${systemAdminToken}`)
      .send({ dailyQuotaUnits: 1000, name: 'lifecycle-project' });
    managerSecret = bootstrap.body.secret as string;
    managerId = bootstrap.body.apiKey.id as string;
  });

  afterAll(async () => {
    await app?.close();
    await harness.stop();
  });

  async function createKey(name: string, scopes: string[]) {
    return request(app.getHttpServer())
      .post('/v1/api-keys')
      .set('Authorization', `Bearer ${managerSecret}`)
      .send({ name, scopes });
  }

  it('enforces authentication and scope before query/path validation', async () => {
    const noScope = await createKey('reader', ['usage:read']);
    const cases = [
      request(app.getHttpServer()).get('/v1/api-keys?limit=01'),
      request(app.getHttpServer()).delete('/v1/api-keys/not-a-uuid'),
    ];
    for (const response of await Promise.all(cases)) {
      expect(response).toMatchObject({
        status: 401,
        headers: { 'www-authenticate': 'Bearer' },
        body: { code: 'INVALID_API_KEY', requestId: expect.any(String) },
      });
      expect(response.body.requestId).toBe(response.headers['x-request-id']);
    }

    for (const response of await Promise.all([
      request(app.getHttpServer())
        .get('/v1/api-keys?limit=01')
        .set('Authorization', `Bearer ${noScope.body.secret as string}`),
      request(app.getHttpServer())
        .delete('/v1/api-keys/not-a-uuid')
        .set('Authorization', `Bearer ${noScope.body.secret as string}`),
    ])) {
      expect(response).toMatchObject({
        status: 403,
        body: { code: 'INSUFFICIENT_SCOPE' },
      });
      expect(response.headers['www-authenticate']).toBeUndefined();
    }

    for (const response of await Promise.all([
      request(app.getHttpServer())
        .get('/v1/api-keys?limit=01')
        .set('Authorization', `Bearer ${managerSecret}`),
      request(app.getHttpServer())
        .delete('/v1/api-keys/not-a-uuid')
        .set('Authorization', `Bearer ${managerSecret}`),
    ])) {
      expect(response).toMatchObject({
        status: 400,
        body: { code: 'VALIDATION_ERROR' },
      });
      expect(response.headers['www-authenticate']).toBeUndefined();
    }
  });

  it('returns unknown API key routes as 404 before authentication or parsing', async () => {
    for (const response of await Promise.all([
      request(app.getHttpServer())
        .delete('/v1/api-keys/')
        .set('Content-Type', 'application/json')
        .send('{'),
      request(app.getHttpServer())
        .post('/v1/api-keys/a/b')
        .set('Content-Type', 'application/json')
        .send('{'),
      request(app.getHttpServer()).patch('/v1/api-keys').send('{'),
    ])) {
      expect(response).toMatchObject({
        status: 404,
        body: { code: 'ROUTE_NOT_FOUND', requestId: expect.any(String) },
      });
      expect(response.headers['www-authenticate']).toBeUndefined();
      expect(response.body.requestId).toBe(response.headers['x-request-id']);
    }
  });

  it('returns an exact cursor page without secret material', async () => {
    await createKey('list-a', ['usage:read']);
    await createKey('list-b', ['audit:read']);
    const first = await request(app.getHttpServer())
      .get('/v1/api-keys?limit=2')
      .set('Authorization', `Bearer ${managerSecret}`);

    expect(first.status).toBe(200);
    expect(Object.keys(first.body)).toEqual(['items', 'nextCursor']);
    expect(first.body.items).toHaveLength(2);
    expect(first.body.nextCursor).toEqual(expect.any(String));
    for (const item of first.body.items as Record<string, unknown>[]) {
      expect(Object.keys(item)).toEqual([
        'id',
        'name',
        'prefix',
        'scopes',
        'status',
        'createdAt',
        'revokedAt',
      ]);
    }
    expect(JSON.stringify(first.body).toLowerCase()).not.toContain('secret');
    expect(JSON.stringify(first.body).toLowerCase()).not.toContain('digest');

    const second = await request(app.getHttpServer())
      .get('/v1/api-keys')
      .query({ cursor: first.body.nextCursor, limit: '2' })
      .set('Authorization', `Bearer ${managerSecret}`);
    expect(second.status).toBe(200);
    expect(second.body.items).toEqual(expect.any(Array));
    expect(
      new Set(
        [...first.body.items, ...second.body.items].map(
          (item: { id: string }) => item.id,
        ),
      ).size,
    ).toBe(first.body.items.length + second.body.items.length);
  });

  it('returns exact empty 204, rejects revoked credentials, and supports replacement-manager rotation', async () => {
    const target = await createKey('revoke-target', ['usage:read']);
    const revoked = await request(app.getHttpServer())
      .delete(`/v1/api-keys/${target.body.apiKey.id as string}`)
      .set('Authorization', `Bearer ${managerSecret}`);
    expect(revoked.status).toBe(204);
    expect(revoked.text).toBe('');
    expect(revoked.headers['content-type']).toBeUndefined();
    expect(revoked.headers['x-request-id']).toEqual(expect.any(String));

    const rejected = await request(app.getHttpServer())
      .get('/v1/api-keys')
      .set('Authorization', `Bearer ${target.body.secret as string}`);
    expect(rejected).toMatchObject({
      status: 401,
      headers: { 'www-authenticate': 'Bearer' },
      body: { code: 'INVALID_API_KEY' },
    });

    const replacement = await createKey('replacement-manager', ['keys:manage']);
    const rotated = await request(app.getHttpServer())
      .delete(`/v1/api-keys/${managerId}`)
      .set('Authorization', `Bearer ${replacement.body.secret as string}`);
    expect(rotated.status).toBe(204);

    const oldManager = await request(app.getHttpServer())
      .get('/v1/api-keys')
      .set('Authorization', `Bearer ${managerSecret}`);
    expect(oldManager).toMatchObject({
      status: 401,
      headers: { 'www-authenticate': 'Bearer' },
      body: { code: 'INVALID_API_KEY' },
    });

    const current = await request(app.getHttpServer())
      .delete(`/v1/api-keys/${replacement.body.apiKey.id as string}`)
      .set('Authorization', `Bearer ${replacement.body.secret as string}`);
    expect(current).toMatchObject({
      status: 409,
      body: { code: 'CANNOT_REVOKE_CURRENT_KEY' },
    });
    expect(current.headers['www-authenticate']).toBeUndefined();
  });
});

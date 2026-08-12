import type { INestApplication } from '@nestjs/common';
import { jest } from '@jest/globals';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../../src/app.module.js';
import { ApiKeyStatus } from '../../src/generated/prisma/client.js';
import { PrismaService } from '../../src/database/prisma.service.js';
import { configureApplication } from '../../src/main.js';
import { createPostgresTestHarness } from '../support/postgres-test-harness.js';
import { testEnvironment } from '../support/test-environment.js';

jest.setTimeout(120_000);

const systemAdminToken = 'a'.repeat(43);
const apiKeyPepper = 'b'.repeat(43);
const metricsToken = 'c'.repeat(43);

describe('POST /v1/api-keys', () => {
  const harness = createPostgresTestHarness();
  let app: INestApplication;
  let managerSecret: string;
  let managerId: string;
  let prisma: PrismaService;

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
      .send({ dailyQuotaUnits: 1000, name: 'api-key-project' });
    managerSecret = bootstrap.body.secret as string;
    managerId = bootstrap.body.apiKey.id as string;
    prisma = app.get(PrismaService);
  });

  afterAll(async () => {
    await app?.close();
    await harness.stop();
  });

  it('authenticates before parsing and issues the secret once with canonical metadata', async () => {
    const unauthorized = await request(app.getHttpServer())
      .post('/v1/api-keys?source=e2e')
      .set('Content-Type', 'application/json')
      .send('{');
    expect(unauthorized).toMatchObject({
      status: 401,
      headers: { 'www-authenticate': 'Bearer' },
      body: { code: 'INVALID_API_KEY', requestId: expect.any(String) },
    });
    expect(unauthorized.body.requestId).toBe(
      unauthorized.headers['x-request-id'],
    );

    const created = await request(app.getHttpServer())
      .post('/v1/api-keys/')
      .set('Authorization', `Bearer ${managerSecret}`)
      .send({
        name: 'usage-reader',
        scopes: ['audit:read', 'usage:read'],
      });

    expect(created).toMatchObject({
      status: 201,
      body: {
        apiKey: {
          id: expect.any(String),
          name: 'usage-reader',
          prefix: expect.stringMatching(/^mq_[0-9a-f-]{36}$/),
          scopes: ['usage:read', 'audit:read'],
          status: 'ACTIVE',
          createdAt: expect.stringMatching(/Z$/),
          revokedAt: null,
        },
        secret: expect.stringMatching(/^mq_[0-9a-f-]{36}\.[A-Za-z0-9_-]{43}$/),
      },
    });
    expect(created.body.apiKey).not.toHaveProperty('secretDigest');
    expect(created.body).not.toHaveProperty('digest');
    expect(Object.keys(created.body)).toEqual(['apiKey', 'secret']);
    expect(Object.keys(created.body.apiKey)).toEqual([
      'id',
      'name',
      'prefix',
      'scopes',
      'status',
      'createdAt',
      'revokedAt',
    ]);
    expect(
      Object.values(created.body).filter(
        (value) => value === created.body.secret,
      ),
    ).toHaveLength(1);
    expect(created.headers['content-type']).toContain('application/json');
    expect(created.headers['x-request-id']).toMatch(/[0-9a-f-]{36}/);
    expect(created.headers['www-authenticate']).toBeUndefined();
  });

  it('retains authorization priority and keeps unrelated api-key routes unregistered', async () => {
    const invalidScope = await request(app.getHttpServer())
      .post('/v1/api-keys')
      .set('Authorization', `Bearer ${managerSecret}`)
      .set('Content-Type', 'text/plain')
      .send('not-json');
    expect(invalidScope).toMatchObject({
      status: 415,
      body: { code: 'UNSUPPORTED_MEDIA_TYPE' },
    });
    expect(invalidScope.headers['www-authenticate']).toBeUndefined();

    const routeNotFound = await request(app.getHttpServer())
      .post('/v1/api-keys/not-a-route')
      .set('Content-Type', 'application/json')
      .send('{');
    expect(routeNotFound).toMatchObject({
      status: 404,
      body: { code: 'ROUTE_NOT_FOUND', requestId: expect.any(String) },
    });
    expect(routeNotFound.headers['www-authenticate']).toBeUndefined();

    const systemAdmin = await request(app.getHttpServer())
      .post('/v1/api-keys')
      .set('Authorization', `Bearer ${systemAdminToken}`)
      .set('Content-Type', 'application/json')
      .send('{');
    expect(systemAdmin).toMatchObject({
      status: 401,
      headers: { 'www-authenticate': 'Bearer' },
      body: { code: 'INVALID_API_KEY', requestId: expect.any(String) },
    });

    const getRoute = await request(app.getHttpServer()).get('/v1/api-keys');
    expect(getRoute).toMatchObject({
      status: 404,
      body: { code: 'ROUTE_NOT_FOUND', requestId: expect.any(String) },
    });

    for (const response of [routeNotFound, systemAdmin, getRoute]) {
      expect(response.body.requestId).toBe(response.headers['x-request-id']);
    }
  });

  it('rejects duplicate scopes instead of normalizing them into a valid request', async () => {
    const response = await request(app.getHttpServer())
      .post('/v1/api-keys')
      .set('Authorization', `Bearer ${managerSecret}`)
      .send({ name: 'duplicate-scope', scopes: ['usage:read', 'usage:read'] });

    expect(response).toMatchObject({
      status: 400,
      body: { code: 'VALIDATION_ERROR' },
    });
  });

  it('keeps 403 scope priority and only challenges 401 credential failures', async () => {
    const malformed = await request(app.getHttpServer())
      .post('/v1/api-keys')
      .set('Authorization', `Bearer ${managerSecret}`)
      .set('Content-Type', 'application/json')
      .send('{');
    expect(malformed).toMatchObject({
      status: 400,
      body: { code: 'VALIDATION_ERROR', requestId: expect.any(String) },
    });
    expect(malformed.headers['www-authenticate']).toBeUndefined();
    expect(malformed.body.requestId).toBe(malformed.headers['x-request-id']);

    const credentialPrefix = managerSecret.slice(
      0,
      managerSecret.indexOf('.') + 1,
    );
    const secretPart = managerSecret.slice(credentialPrefix.length);
    const wrongSecret = `${credentialPrefix}${secretPart.startsWith('A') ? 'B' : 'A'}${secretPart.slice(1)}`;
    const wrongSecretResponse = await request(app.getHttpServer())
      .post('/v1/api-keys')
      .set('Authorization', `Bearer ${wrongSecret}`)
      .set('Content-Type', 'application/json')
      .send('{');
    expect(wrongSecretResponse).toMatchObject({
      status: 401,
      headers: { 'www-authenticate': 'Bearer' },
      body: { code: 'INVALID_API_KEY' },
    });

    const issued = await request(app.getHttpServer())
      .post('/v1/api-keys')
      .set('Authorization', `Bearer ${managerSecret}`)
      .send({ name: 'reader', scopes: ['usage:read'] });
    const insufficient = await request(app.getHttpServer())
      .post('/v1/api-keys')
      .set('Authorization', `Bearer ${issued.body.secret as string}`)
      .set('Content-Type', 'application/json')
      .send('{');
    expect(insufficient).toMatchObject({
      status: 403,
      body: { code: 'INSUFFICIENT_SCOPE' },
    });
    expect(insufficient.headers['www-authenticate']).toBeUndefined();

    const metrics = await request(app.getHttpServer())
      .post('/v1/api-keys')
      .set('Authorization', `Bearer ${metricsToken}`)
      .set('Content-Type', 'application/json')
      .send('{');
    expect(metrics).toMatchObject({
      status: 401,
      headers: { 'www-authenticate': 'Bearer' },
      body: { code: 'INVALID_API_KEY' },
    });

    await prisma.apiKey.update({
      where: { id: managerId },
      data: { status: ApiKeyStatus.REVOKED, revokedAt: new Date() },
    });
    const revoked = await request(app.getHttpServer())
      .post('/v1/api-keys')
      .set('Authorization', `Bearer ${managerSecret}`)
      .set('Content-Type', 'application/json')
      .send('{');
    expect(revoked).toMatchObject({
      status: 401,
      headers: { 'www-authenticate': 'Bearer' },
      body: { code: 'INVALID_API_KEY' },
    });
  });
});

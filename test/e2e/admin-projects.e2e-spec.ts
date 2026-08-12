import type { INestApplication } from '@nestjs/common';
import { jest } from '@jest/globals';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../../src/app.module.js';
import { PrismaService } from '../../src/database/prisma.service.js';
import { configureApplication } from '../../src/main.js';
import { createPostgresTestHarness } from '../support/postgres-test-harness.js';
import { testEnvironment } from '../support/test-environment.js';

jest.setTimeout(120_000);

const systemAdminToken = 'a'.repeat(43);
const apiKeyPepper = 'b'.repeat(43);
const metricsToken = 'c'.repeat(43);

describe('POST /v1/admin/projects', () => {
  const harness = createPostgresTestHarness();
  let app: INestApplication;
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
    prisma = app.get(PrismaService);
  });

  afterAll(async () => {
    await app?.close();
    await harness.stop();
  });

  it('authenticates before media-type validation and issues an initial admin key', async () => {
    const unauthorized = await request(app.getHttpServer())
      .post('/v1/admin/projects')
      .set('Content-Type', 'text/plain')
      .send('not-json');
    expect(unauthorized).toMatchObject({
      status: 401,
      headers: { 'www-authenticate': 'Bearer' },
      body: { code: 'INVALID_SYSTEM_ADMIN_TOKEN' },
    });

    const unsupportedMediaType = await request(app.getHttpServer())
      .post('/v1/admin/projects')
      .set('Authorization', `Bearer ${systemAdminToken}`)
      .set('Content-Type', 'text/plain')
      .send('not-json');
    expect(unsupportedMediaType).toMatchObject({
      status: 415,
      body: { code: 'UNSUPPORTED_MEDIA_TYPE' },
    });
    expect(unsupportedMediaType.headers['www-authenticate']).toBeUndefined();

    const response = await request(app.getHttpServer())
      .post('/v1/admin/projects')
      .set('Authorization', `Bearer ${systemAdminToken}`)
      .send({ name: 'portfolio-demo', dailyQuotaUnits: 1000 });

    expect(response).toMatchObject({
      status: 201,
      body: {
        project: {
          id: expect.any(String),
          name: 'portfolio-demo',
          dailyQuotaUnits: 1000,
          createdAt: expect.stringMatching(/Z$/),
        },
        apiKey: {
          id: expect.any(String),
          name: 'initial-admin',
          prefix: expect.stringMatching(/^mq_[0-9a-f-]{36}$/),
          scopes: ['usage:write', 'usage:read', 'keys:manage', 'audit:read'],
          status: 'ACTIVE',
          revokedAt: null,
        },
        secret: expect.stringMatching(/^mq_[0-9a-f-]{36}\.[A-Za-z0-9_-]{43}$/),
      },
    });
    expect(response.body.secret).toContain(response.body.apiKey.id);
    expect(response.body.requestId).toBeUndefined();
    expect(response.body.apiKey).not.toHaveProperty('secretDigest');
    expect(response.headers['x-request-id']).toMatch(/[0-9a-f-]{36}/);
    expect(response.headers['www-authenticate']).toBeUndefined();
  });

  it('authenticates malformed JSON before the Nest JSON parser', async () => {
    const missingCredential = await request(app.getHttpServer())
      .post('/v1/admin/projects')
      .set('Content-Type', 'application/json')
      .send('{');
    expect(missingCredential).toMatchObject({
      status: 401,
      headers: {
        'www-authenticate': 'Bearer',
      },
      body: {
        code: 'INVALID_SYSTEM_ADMIN_TOKEN',
        requestId: expect.any(String),
      },
    });
    expect(missingCredential.body.requestId).toBe(
      missingCredential.headers['x-request-id'],
    );

    const invalidCredential = await request(app.getHttpServer())
      .post('/v1/admin/projects')
      .set('Authorization', 'Bearer invalid-admin-token')
      .set('Content-Type', 'application/json')
      .send('{');
    expect(invalidCredential).toMatchObject({
      status: 401,
      headers: { 'www-authenticate': 'Bearer' },
      body: {
        code: 'INVALID_SYSTEM_ADMIN_TOKEN',
        requestId: expect.any(String),
      },
    });
    expect(invalidCredential.body.requestId).toBe(
      invalidCredential.headers['x-request-id'],
    );

    const validCredential = await request(app.getHttpServer())
      .post('/v1/admin/projects')
      .set('Authorization', `Bearer ${systemAdminToken}`)
      .set('Content-Type', 'application/json')
      .send('{');
    expect(validCredential).toMatchObject({
      status: 400,
      body: {
        code: 'VALIDATION_ERROR',
        requestId: expect.any(String),
      },
    });
    expect(validCredential.headers['www-authenticate']).toBeUndefined();
    expect(validCredential.body.requestId).toBe(
      validCredential.headers['x-request-id'],
    );
  });

  it('does not authenticate unregistered methods or descendant paths', async () => {
    for (const response of [
      await request(app.getHttpServer()).get('/v1/admin/projects'),
      await request(app.getHttpServer()).options('/v1/admin/projects'),
      await request(app.getHttpServer())
        .post('/v1/admin/projects/not-a-route')
        .send({}),
    ]) {
      expect(response).toMatchObject({
        status: 404,
        headers: {
          'content-type': expect.stringContaining('application/problem+json'),
        },
        body: {
          code: 'ROUTE_NOT_FOUND',
          requestId: expect.any(String),
        },
      });
      expect(response.headers['www-authenticate']).toBeUndefined();
      expect(response.body.requestId).toBe(response.headers['x-request-id']);
    }
  });

  it('keeps auth-before-parser on query-string and trailing-slash bootstrap requests', async () => {
    for (const path of [
      '/v1/admin/projects?source=test',
      '/v1/admin/projects/',
    ]) {
      const missingCredential = await request(app.getHttpServer())
        .post(path)
        .set('Content-Type', 'application/json')
        .send('{');
      expect(missingCredential).toMatchObject({
        status: 401,
        headers: { 'www-authenticate': 'Bearer' },
        body: { code: 'INVALID_SYSTEM_ADMIN_TOKEN' },
      });

      const validCredential = await request(app.getHttpServer())
        .post(path)
        .set('Authorization', `Bearer ${systemAdminToken}`)
        .set('Content-Type', 'application/json')
        .send('{');
      expect(validCredential).toMatchObject({
        status: 400,
        body: { code: 'VALIDATION_ERROR' },
      });
      expect(validCredential.headers['www-authenticate']).toBeUndefined();
    }
  });

  it('matches the framework-accepted bootstrap path without case drift', async () => {
    const response = await request(app.getHttpServer())
      .post('/V1/ADMIN/PROJECTS')
      .set('Content-Type', 'application/json')
      .send('{');

    expect(response).toMatchObject({
      status: 401,
      headers: { 'www-authenticate': 'Bearer' },
      body: { code: 'INVALID_SYSTEM_ADMIN_TOKEN' },
    });
  });

  it('rejects metrics and project API credentials while preserving audit correlation and non-idempotency', async () => {
    const first = await request(app.getHttpServer())
      .post('/v1/admin/projects')
      .set('Authorization', `Bearer ${systemAdminToken}`)
      .send({ name: 'credential-separation', dailyQuotaUnits: 123 });
    const second = await request(app.getHttpServer())
      .post('/v1/admin/projects')
      .set('Authorization', `Bearer ${systemAdminToken}`)
      .send({ name: 'credential-separation', dailyQuotaUnits: 123 });

    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(first.headers['www-authenticate']).toBeUndefined();
    expect(second.headers['www-authenticate']).toBeUndefined();
    expect(first.body.project.id).not.toBe(second.body.project.id);
    expect(first.body.apiKey.id).not.toBe(second.body.apiKey.id);

    const audit = await prisma.auditLog.findFirstOrThrow({
      where: { projectId: first.body.project.id },
    });
    expect(audit.requestId).toBe(first.headers['x-request-id']);
    const secondAudit = await prisma.auditLog.findFirstOrThrow({
      where: { projectId: second.body.project.id },
    });
    expect(secondAudit.requestId).toBe(second.headers['x-request-id']);
    expect(secondAudit.requestId).not.toBe(audit.requestId);

    for (const credential of [metricsToken, first.body.secret]) {
      const response = await request(app.getHttpServer())
        .post('/v1/admin/projects')
        .set('Authorization', `Bearer ${credential}`)
        .send({ name: 'rejected-credential', dailyQuotaUnits: 1 });

      expect(response).toMatchObject({
        status: 401,
        headers: {
          'content-type': expect.stringContaining('application/problem+json'),
          'www-authenticate': 'Bearer',
        },
        body: {
          code: 'INVALID_SYSTEM_ADMIN_TOKEN',
          detail: expect.any(String),
          requestId: expect.any(String),
          status: 401,
          title: expect.any(String),
          type: 'urn:api-usage-quota-service:problem:invalid-system-admin-token',
        },
      });
      expect(response.body.requestId).toBe(response.headers['x-request-id']);
    }
  });
});

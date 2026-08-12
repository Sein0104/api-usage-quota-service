import type { INestApplication } from '@nestjs/common';
import { jest } from '@jest/globals';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../../src/app.module.js';
import { configureApplication } from '../../src/main.js';
import { createPostgresTestHarness } from '../support/postgres-test-harness.js';

jest.setTimeout(120_000);

const systemAdminToken = 'a'.repeat(43);
const apiKeyPepper = 'b'.repeat(43);

describe('POST /v1/admin/projects', () => {
  const harness = createPostgresTestHarness();
  let app: INestApplication;

  beforeAll(async () => {
    await harness.start();
    await harness.migrate();
    process.env.DATABASE_URL = harness.databaseUrl;
    process.env.SYSTEM_ADMIN_TOKEN = systemAdminToken;
    process.env.API_KEY_PEPPER = apiKeyPepper;

    const module = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = module.createNestApplication();
    configureApplication(app);
    await app.init();
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
  });
});

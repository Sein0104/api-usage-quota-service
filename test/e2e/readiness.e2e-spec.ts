import { type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../../src/app.module.js';
import { MigrationStatusService } from '../../src/database/migration-status.service.js';
import { configureApplication } from '../../src/main.js';
import { testEnvironment } from '../support/test-environment.js';

describe('readiness HTTP contract', () => {
  let app: INestApplication;

  async function startWithReadiness(
    readiness: () => Promise<boolean>,
  ): Promise<void> {
    const module = await Test.createTestingModule({
      imports: [AppModule.forRoot(testEnvironment())],
    })
      .overrideProvider(MigrationStatusService)
      .useValue({ isReady: readiness })
      .compile();
    app = module.createNestApplication();
    configureApplication(app);
    await app.init();
  }

  afterEach(async () => {
    await app?.close();
  });

  it('returns 503 JSON without database details when PostgreSQL is unavailable', async () => {
    await startWithReadiness(async () => false);

    const response = await request(app.getHttpServer()).get('/health/ready');

    expect(response.status).toBe(503);
    expect(response.headers['content-type']).toContain('application/json');
    expect(response.headers['x-request-id']).toBeDefined();
    expect(response.body).toEqual({ status: 'not_ready' });
  });

  it('returns 503 JSON when the expected migration is incomplete', async () => {
    await startWithReadiness(async () => false);

    const response = await request(app.getHttpServer()).get('/health/ready');

    expect(response.status).toBe(503);
    expect(response.body).toEqual({ status: 'not_ready' });
  });

  it('returns 200 JSON when PostgreSQL and all expected migrations are ready', async () => {
    await startWithReadiness(async () => true);

    const response = await request(app.getHttpServer()).get('/health/ready');

    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toContain('application/json');
    expect(response.body).toEqual({ status: 'ready' });
  });

  it('returns generic 500 Problem Details for an unexpected readiness error', async () => {
    await startWithReadiness(async () => {
      throw new Error('postgresql://secret-user:secret-password@db/private');
    });

    const response = await request(app.getHttpServer()).get('/health/ready');

    expect(response).toMatchObject({
      status: 500,
      headers: {
        'content-type': expect.stringContaining('application/problem+json'),
      },
      body: {
        code: 'INTERNAL_ERROR',
        requestId: expect.any(String),
      },
    });
    expect(JSON.stringify(response.body)).not.toContain('secret-password');
  });
});

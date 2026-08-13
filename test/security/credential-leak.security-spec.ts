import type { INestApplication } from '@nestjs/common';
import { beforeEach, jest } from '@jest/globals';
import { Test } from '@nestjs/testing';
import pino, { type DestinationStream } from 'pino';
import { Pool } from 'pg';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import type { Response as SupertestResponse } from 'supertest';
import { AppModule } from '../../src/app.module.js';
import { configureApplication } from '../../src/main.js';
import { createOpenApiDocument, stableOpenApiJson } from '../../src/openapi.js';
import { testEnvironment } from '../support/test-environment.js';
import { createPostgresTestHarness } from '../support/postgres-test-harness.js';
import { cleanDatabase } from '../support/database-cleaner.js';
import { SAFE_APPLICATION_LOGGER_ROOT } from '../../src/observability/safe-application-logger.js';
import { MetricsService } from '../../src/observability/metrics.service.js';

jest.setTimeout(120_000);

describe('credential leak security', () => {
  const secrets = {
    API_KEY_PEPPER: `pepper-${'p'.repeat(43)}`,
    DATABASE_URL:
      'postgresql://db-user:db-password-canary@localhost:5432/database-canary',
    METRICS_TOKEN: `metrics-${'m'.repeat(43)}`,
    SYSTEM_ADMIN_TOKEN: `admin-${'s'.repeat(43)}`,
  };

  it('does not include configured credential values or internal credential fields in OpenAPI', async () => {
    const module = await Test.createTestingModule({
      imports: [AppModule.forRoot(testEnvironment(secrets))],
    }).compile();
    const app: INestApplication = module.createNestApplication();
    configureApplication(app);
    await app.init();
    try {
      const serialized = stableOpenApiJson(createOpenApiDocument(app));
      for (const canary of Object.values(secrets)) {
        expect(serialized).not.toContain(canary);
      }
      expect(serialized).not.toMatch(/secretDigest|databaseUrl|authorization/i);
      const parsed = JSON.parse(serialized) as {
        components: {
          schemas: Record<string, { properties?: Record<string, unknown> }>;
        };
      };
      for (const [name, schema] of Object.entries(parsed.components.schemas)) {
        if (
          name === 'ProjectBootstrapResponseModel' ||
          name === 'ApiKeyCreateResponseModel'
        ) {
          expect(schema.properties?.secret).toMatchObject({
            format: 'password',
            readOnly: true,
          });
        } else {
          expect(schema.properties ?? {}).not.toHaveProperty('secret');
        }
      }
    } finally {
      await app.close();
    }
  });

  it('keeps each credential class bound only to its endpoint', async () => {
    const environment = testEnvironment(secrets);
    const module = await Test.createTestingModule({
      imports: [AppModule.forRoot(environment)],
    }).compile();
    const app: INestApplication = module.createNestApplication();
    configureApplication(app);
    await app.init();
    try {
      const projectCredential = `mq_11111111-2222-4333-8444-555555555555.${'a'.repeat(43)}`;
      for (const foreign of [secrets.METRICS_TOKEN, projectCredential]) {
        const response = await request(app.getHttpServer())
          .post('/v1/admin/projects')
          .set('Authorization', `Bearer ${foreign}`)
          .send({ dailyQuotaUnits: 1, name: 'nope' });
        expect(response.status).toBe(401);
        expect(response.body.code).toBe('INVALID_SYSTEM_ADMIN_TOKEN');
      }
      for (const foreign of [secrets.SYSTEM_ADMIN_TOKEN, projectCredential]) {
        const response = await request(app.getHttpServer())
          .get('/metrics')
          .set('Authorization', `Bearer ${foreign}`);
        expect(response.status).toBe(401);
        expect(response.body.code).toBe('INVALID_METRICS_TOKEN');
      }
      for (const foreign of [
        secrets.SYSTEM_ADMIN_TOKEN,
        secrets.METRICS_TOKEN,
      ]) {
        const response = await request(app.getHttpServer())
          .get('/v1/api-keys')
          .set('Authorization', `Bearer ${foreign}`);
        expect(response.status).toBe(401);
        expect(response.body.code).toBe('INVALID_API_KEY');
      }
    } finally {
      await app.close();
    }
  });

  describe('real credential separation and persistence boundary', () => {
    const harness = createPostgresTestHarness();
    const logLines: string[] = [];
    let app: INestApplication;
    let pool: Pool;
    let projectCredential: string;

    beforeAll(async () => {
      await harness.start();
      await harness.migrate();
      pool = new Pool({ connectionString: harness.databaseUrl });
      const destination: DestinationStream = {
        write(chunk: string) {
          logLines.push(chunk);
        },
      };
      const root = pino({ base: null, timestamp: false }, destination);
      const module = await Test.createTestingModule({
        imports: [
          AppModule.forRoot(
            testEnvironment({
              ...secrets,
              DATABASE_URL: harness.databaseUrl,
            }),
          ),
        ],
      })
        .overrideProvider(SAFE_APPLICATION_LOGGER_ROOT)
        .useValue(() => root)
        .compile();
      app = module.createNestApplication();
      configureApplication(app);
      await app.init();
    });

    beforeEach(async () => {
      logLines.length = 0;
      await cleanDatabase(pool);
      const bootstrapped = await request(app.getHttpServer())
        .post('/v1/admin/projects')
        .set('Authorization', `Bearer ${secrets.SYSTEM_ADMIN_TOKEN}`)
        .send({ dailyQuotaUnits: 10, name: `security-${randomUUID()}` });
      expect(bootstrapped.status).toBe(201);
      projectCredential = bootstrapped.body.secret as string;
    });

    afterAll(async () => {
      await app?.close();
      await pool?.end();
      await harness.stop();
    });

    function expectCredentialProblem(
      response: SupertestResponse,
      code:
        | 'INVALID_API_KEY'
        | 'INVALID_METRICS_TOKEN'
        | 'INVALID_SYSTEM_ADMIN_TOKEN',
    ) {
      const expected = {
        INVALID_API_KEY: {
          detail: 'The API key credential is invalid.',
          title: 'Invalid API key',
        },
        INVALID_METRICS_TOKEN: {
          detail: 'The metrics token is invalid.',
          title: 'Invalid metrics token',
        },
        INVALID_SYSTEM_ADMIN_TOKEN: {
          detail: 'The system administrator credential is invalid.',
          title: 'Invalid system administrator token',
        },
      }[code];
      expect(response.status).toBe(401);
      expect(response.headers['content-type']).toContain(
        'application/problem+json',
      );
      expect(response.headers['www-authenticate']).toBe('Bearer');
      expect(response.headers['x-request-id']).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      );
      expect(response.body).toEqual({
        code,
        detail: expected.detail,
        requestId: response.headers['x-request-id'],
        status: 401,
        title: expected.title,
        type: `urn:api-usage-quota-service:problem:${code
          .toLowerCase()
          .replaceAll('_', '-')}`,
      });
    }

    async function callEndpoint(
      endpoint: 'admin' | 'metrics' | 'project',
      credential: string,
    ) {
      if (endpoint === 'admin') {
        return request(app.getHttpServer())
          .post('/v1/admin/projects')
          .set('Authorization', `Bearer ${credential}`)
          .send({ dailyQuotaUnits: 1, name: 'credential-matrix' });
      }
      if (endpoint === 'metrics') {
        return request(app.getHttpServer())
          .get('/metrics')
          .set('Authorization', `Bearer ${credential}`);
      }
      return request(app.getHttpServer())
        .get('/v1/api-keys')
        .set('Authorization', `Bearer ${credential}`);
    }

    it('accepts all three diagonal credentials with their full response contracts', async () => {
      const admin = await callEndpoint('admin', secrets.SYSTEM_ADMIN_TOKEN);
      expect(admin.status).toBe(201);
      expect(admin.headers['www-authenticate']).toBeUndefined();
      expect(admin.headers['x-request-id']).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      );
      expect(admin.body).toEqual({
        apiKey: expect.objectContaining({
          id: expect.any(String),
          prefix: expect.any(String),
          scopes: ['usage:write', 'usage:read', 'keys:manage', 'audit:read'],
          status: 'ACTIVE',
        }),
        project: expect.objectContaining({
          dailyQuotaUnits: 1,
          id: expect.any(String),
          name: 'credential-matrix',
        }),
        secret: expect.stringMatching(/^mq_[^.]+\.[A-Za-z0-9_-]{43}$/),
      });

      const metrics = await callEndpoint('metrics', secrets.METRICS_TOKEN);
      expect(metrics.status).toBe(200);
      expect(metrics.headers['content-type']).toBe(
        app.get(MetricsService).contentType,
      );
      expect(metrics.headers['www-authenticate']).toBeUndefined();
      expect(metrics.headers['x-request-id']).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      );

      const project = await callEndpoint('project', projectCredential);
      expect(project.status).toBe(200);
      expect(project.headers['www-authenticate']).toBeUndefined();
      expect(project.body).toEqual({
        items: [
          expect.objectContaining({
            name: 'initial-admin',
            scopes: ['usage:write', 'usage:read', 'keys:manage', 'audit:read'],
            status: 'ACTIVE',
          }),
        ],
        nextCursor: null,
      });
    });

    it.each([
      ['admin', 'metrics', 'INVALID_METRICS_TOKEN'],
      ['admin', 'project', 'INVALID_API_KEY'],
      ['metrics', 'admin', 'INVALID_SYSTEM_ADMIN_TOKEN'],
      ['metrics', 'project', 'INVALID_API_KEY'],
      ['project', 'admin', 'INVALID_SYSTEM_ADMIN_TOKEN'],
      ['project', 'metrics', 'INVALID_METRICS_TOKEN'],
    ] as const)(
      'rejects the %s credential at the %s endpoint',
      async (credentialClass, endpoint, code) => {
        const credential = {
          admin: secrets.SYSTEM_ADMIN_TOKEN,
          metrics: secrets.METRICS_TOKEN,
          project: projectCredential,
        }[credentialClass];
        expectCredentialProblem(await callEndpoint(endpoint, credential), code);
      },
    );

    it('keeps issued, authorization, query, idempotency, and environment canaries out of logs and audit metadata', async () => {
      const queryCanary = `query-${randomUUID()}`;
      const idempotencyCanary = randomUUID();
      const issued = await request(app.getHttpServer())
        .post('/v1/api-keys')
        .set('Authorization', `Bearer ${projectCredential}`)
        .send({ name: 'leak-scan-key', scopes: ['usage:write'] });
      expect(issued.status).toBe(201);
      const issuedPlaintext = issued.body.secret as string;

      await request(app.getHttpServer())
        .get(`/v1/api-keys?cursor=${queryCanary}`)
        .set('Authorization', `Bearer ${projectCredential}`)
        .expect(400);
      await request(app.getHttpServer())
        .post('/v1/usage-events')
        .set('Authorization', `Bearer ${issuedPlaintext}`)
        .set('Idempotency-Key', idempotencyCanary)
        .send({ units: 1 })
        .expect(200);

      const auditMetadata = await pool.query<{ metadata: string }>(
        'SELECT metadata::text AS metadata FROM audit_logs',
      );
      const persisted = JSON.stringify(auditMetadata.rows);
      const capturedLogs = logLines.join('');
      const canaries = [
        ...Object.values(secrets),
        harness.databaseUrl,
        new URL(harness.databaseUrl).password,
        projectCredential,
        issuedPlaintext,
        `Bearer ${projectCredential}`,
        `Bearer ${issuedPlaintext}`,
        queryCanary,
        idempotencyCanary,
      ];
      for (const canary of canaries) {
        expect(capturedLogs).not.toContain(canary);
        expect(persisted).not.toContain(canary);
      }
      for (const line of logLines) {
        expect(JSON.parse(line)).toEqual({
          duration: expect.any(Number),
          level: 30,
          msg: 'request completed',
          outcome: expect.stringMatching(
            /^(SUCCESS|CLIENT_ERROR|SERVER_ERROR)$/,
          ),
          request_id: expect.any(String),
          route: expect.any(String),
          status: expect.any(Number),
        });
      }
    });
  });
});

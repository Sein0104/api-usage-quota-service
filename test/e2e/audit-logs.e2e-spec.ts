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

describe('GET /v1/audit-logs', () => {
  const harness = createPostgresTestHarness();
  const systemAdminToken = 'a'.repeat(43);
  let app: INestApplication;
  let pool: Pool;
  let managerSecret: string;
  let managerApiKeyId: string;
  let projectId: string;
  let projectName: string;

  beforeAll(async () => {
    await harness.start();
    await harness.migrate();
    pool = new Pool({ connectionString: harness.databaseUrl });
    const module = await Test.createTestingModule({
      imports: [
        AppModule.forRoot(
          testEnvironment({
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
    projectName = `audit-${randomUUID()}`;
    const bootstrapped = await request(app.getHttpServer())
      .post('/v1/admin/projects')
      .set('Authorization', `Bearer ${systemAdminToken}`)
      .send({ dailyQuotaUnits: 1000, name: projectName });
    managerSecret = bootstrapped.body.secret as string;
    managerApiKeyId = bootstrapped.body.apiKey.id as string;
    projectId = bootstrapped.body.project.id as string;
  });

  afterAll(async () => {
    await app?.close();
    await pool?.end();
    await harness.stop();
  });

  it('enforces authentication and scope before query validation', async () => {
    const noScope = await request(app.getHttpServer())
      .post('/v1/api-keys')
      .set('Authorization', `Bearer ${managerSecret}`)
      .send({ name: 'writer', scopes: ['usage:write'] });
    const unauthorized = await request(app.getHttpServer()).get(
      '/v1/audit-logs?cursor=broken',
    );
    const forbidden = await request(app.getHttpServer())
      .get('/v1/audit-logs?cursor=broken')
      .set('Authorization', `Bearer ${noScope.body.secret as string}`);
    const invalid = await request(app.getHttpServer())
      .get('/v1/audit-logs?cursor=broken')
      .set('Authorization', `Bearer ${managerSecret}`);

    expect(unauthorized.body.code).toBe('INVALID_API_KEY');
    expect(unauthorized.status).toBe(401);
    expect(forbidden.body.code).toBe('INSUFFICIENT_SCOPE');
    expect(forbidden.status).toBe(403);
    expect(invalid.body.code).toBe('INVALID_CURSOR');
    expect(invalid.status).toBe(400);
  });

  it('returns all three exact action shapes without tenant or credential material', async () => {
    const created = await request(app.getHttpServer())
      .post('/v1/api-keys')
      .set('Authorization', `Bearer ${managerSecret}`)
      .send({ name: 'worker', scopes: ['usage:write'] });
    await request(app.getHttpServer())
      .delete(`/v1/api-keys/${created.body.apiKey.id as string}`)
      .set('Authorization', `Bearer ${managerSecret}`)
      .expect(204);

    const response = await request(app.getHttpServer())
      .get('/v1/audit-logs?limit=10')
      .set('Authorization', `Bearer ${managerSecret}`);

    expect(response.status).toBe(200);
    expect(
      response.body.items.map((item: { action: string }) => item.action),
    ).toEqual(['API_KEY_REVOKED', 'API_KEY_CREATED', 'PROJECT_CREATED']);
    expect(response.body.items[0]).toEqual({
      action: 'API_KEY_REVOKED',
      actorKeyId: expect.any(String),
      createdAt: expect.any(String),
      id: expect.any(String),
      metadata: {
        name: 'worker',
        prefix: created.body.apiKey.prefix,
      },
      requestId: expect.any(String),
      resourceId: created.body.apiKey.id,
      resourceType: 'API_KEY',
    });
    expect(response.body.items[1]).toEqual({
      action: 'API_KEY_CREATED',
      actorKeyId: managerApiKeyId,
      createdAt: expect.any(String),
      id: expect.any(String),
      metadata: {
        name: 'worker',
        prefix: created.body.apiKey.prefix,
        scopes: ['usage:write'],
      },
      requestId: expect.any(String),
      resourceId: created.body.apiKey.id,
      resourceType: 'API_KEY',
    });
    expect(response.body.items[2]).toEqual({
      action: 'PROJECT_CREATED',
      actorKeyId: null,
      createdAt: expect.any(String),
      id: expect.any(String),
      metadata: {
        dailyQuotaUnits: 1000,
        initialApiKeyId: managerApiKeyId,
        projectName,
      },
      requestId: expect.any(String),
      resourceId: projectId,
      resourceType: 'PROJECT',
    });
    const rawSerialized = JSON.stringify(response.body);
    const serialized = rawSerialized.toLowerCase();
    expect(serialized).not.toContain('secret');
    expect(serialized).not.toContain('digest');
    expect(serialized).not.toContain('authorization');
    expect(rawSerialized).not.toContain(managerSecret);
    expect(rawSerialized).not.toContain(created.body.secret as string);
    for (const item of response.body.items as Record<string, unknown>[]) {
      expect(item).not.toHaveProperty('projectId');
    }
  });

  it('paginates strict same-timestamp ties and never crosses tenant boundaries', async () => {
    const otherProjectId = randomUUID();
    const otherAuditId = '90000000-0000-4000-8000-000000000009';
    await pool.query(
      `INSERT INTO projects (id, name, daily_quota_units) VALUES ($1, $2, 1)`,
      [otherProjectId, `other-${randomUUID()}`],
    );
    const timestamp = '2026-08-12T12:34:56.789Z';
    const actorKeyId = (
      await pool.query('SELECT id FROM api_keys WHERE project_id = $1', [
        projectId,
      ])
    ).rows[0].id as string;
    const tieIds = [
      '30000000-0000-4000-8000-000000000003',
      '20000000-0000-4000-8000-000000000002',
      '10000000-0000-4000-8000-000000000001',
    ];
    const initialAuditId = (
      await pool.query(
        'SELECT id FROM audit_logs WHERE project_id = $1 AND action = $2',
        [projectId, 'PROJECT_CREATED'],
      )
    ).rows[0].id as string;
    for (const id of tieIds) {
      await pool.query(
        `INSERT INTO audit_logs
          (id, project_id, actor_key_id, action, resource_api_key_id, request_id, metadata, created_at)
         VALUES ($1, $2, $3, 'API_KEY_REVOKED', $3, $4, $5, $6)`,
        [
          id,
          projectId,
          actorKeyId,
          randomUUID(),
          { name: 'initial-admin', prefix: `mq_${actorKeyId}` },
          timestamp,
        ],
      );
    }
    await pool.query(
      `INSERT INTO audit_logs
        (id, project_id, action, request_id, metadata, created_at)
       VALUES ($1, $2, 'PROJECT_CREATED', $3, $4, $5)`,
      [
        otherAuditId,
        otherProjectId,
        randomUUID(),
        {
          dailyQuotaUnits: 1,
          initialApiKeyId: randomUUID(),
          projectName: 'other',
        },
        timestamp,
      ],
    );

    const ids: string[] = [];
    let cursor: string | null = null;
    do {
      const response = await request(app.getHttpServer())
        .get('/v1/audit-logs')
        .query({ ...(cursor === null ? {} : { cursor }), limit: 2 })
        .set('Authorization', `Bearer ${managerSecret}`);
      expect(response.status).toBe(200);
      ids.push(
        ...(response.body.items as { id: string }[]).map((item) => item.id),
      );
      cursor = response.body.nextCursor as string | null;
    } while (cursor !== null);

    expect(ids).toEqual([initialAuditId, ...tieIds]);
    expect(new Set(ids).size).toBe(4);
    expect(ids).not.toContain(otherAuditId);
  });

  it('keeps wrong methods and descendants parser-before 404', async () => {
    for (const response of await Promise.all([
      request(app.getHttpServer()).post('/v1/audit-logs').send('{'),
      request(app.getHttpServer()).get('/v1/audit-logs/child'),
      request(app.getHttpServer()).delete('/v1/audit-logs/a/b'),
    ])) {
      expect(response.status).toBe(404);
      expect(response.body.code).toBe('ROUTE_NOT_FOUND');
      expect(response.headers['www-authenticate']).toBeUndefined();
    }
  });
});

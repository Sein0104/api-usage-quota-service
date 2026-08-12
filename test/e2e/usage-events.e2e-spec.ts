import type { INestApplication } from '@nestjs/common';
import { beforeEach, jest } from '@jest/globals';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import {
  type IncomingHttpHeaders,
  request as sendHttpRequest,
} from 'node:http';
import type { AddressInfo } from 'node:net';
import request from 'supertest';
import { AppModule } from '../../src/app.module.js';
import { configureApplication } from '../../src/main.js';
import { createPostgresTestHarness } from '../support/postgres-test-harness.js';
import { testEnvironment } from '../support/test-environment.js';

jest.setTimeout(120_000);

const systemAdminToken = 'a'.repeat(43);
const apiKeyPepper = 'b'.repeat(43);
const metricsToken = 'c'.repeat(43);

describe('POST /v1/usage-events', () => {
  const harness = createPostgresTestHarness();
  let app: INestApplication;
  let managerSecret: string;
  let noScopeSecret: string;

  interface RawUsageResponse {
    body: Record<string, unknown>;
    headers: IncomingHttpHeaders;
    status: number;
  }

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
    await app.listen(0, '127.0.0.1');
  });

  beforeEach(async () => {
    const bootstrap = await request(app.getHttpServer())
      .post('/v1/admin/projects')
      .set('Authorization', `Bearer ${systemAdminToken}`)
      .send({ dailyQuotaUnits: 3, name: `usage-${randomUUID()}` });
    managerSecret = bootstrap.body.secret as string;
    const noScope = await request(app.getHttpServer())
      .post('/v1/api-keys')
      .set('Authorization', `Bearer ${managerSecret}`)
      .send({ name: 'usage-reader', scopes: ['usage:read'] });
    noScopeSecret = noScope.body.secret as string;
  });

  afterAll(async () => {
    await app?.close();
    await harness.stop();
  });

  function post(key: string) {
    return request(app.getHttpServer())
      .post('/v1/usage-events')
      .set('Authorization', `Bearer ${managerSecret}`)
      .set('Idempotency-Key', key);
  }

  function postWithDuplicateRawIdempotencyKeys(
    first: string,
    second: string,
  ): Promise<RawUsageResponse> {
    const address = app.getHttpServer().address() as
      AddressInfo | string | null;
    if (address === null || typeof address === 'string') {
      throw new Error('The E2E HTTP server must listen on a TCP port.');
    }

    return new Promise((resolve, reject) => {
      const outgoing = sendHttpRequest(
        {
          headers: [
            'Authorization',
            `Bearer ${managerSecret}`,
            'Idempotency-Key',
            first,
            'Idempotency-Key',
            second,
            'Host',
            `127.0.0.1:${address.port}`,
            'Content-Type',
            'application/json',
            'Content-Length',
            '1',
            'Connection',
            'close',
          ],
          host: '127.0.0.1',
          method: 'POST',
          path: '/v1/usage-events',
          port: address.port,
        },
        (response) => {
          let body = '';
          response.setEncoding('utf8');
          response.on('data', (chunk: string) => {
            body += chunk;
          });
          response.on('end', () => {
            resolve({
              body: JSON.parse(body) as Record<string, unknown>,
              headers: response.headers,
              status: response.statusCode ?? 0,
            });
          });
        },
      );
      outgoing.once('error', reject);
      outgoing.setTimeout(10_000, () => {
        outgoing.destroy(new Error('Raw duplicate-header request timed out.'));
      });
      outgoing.end('{');
    });
  }

  it('keeps authentication and scope ahead of idempotency and JSON parsing', async () => {
    const unauthorized = await request(app.getHttpServer())
      .post('/v1/usage-events')
      .set('Content-Type', 'application/json')
      .send('{');
    expect(unauthorized).toMatchObject({
      status: 401,
      headers: {
        'content-type': expect.stringContaining('application/problem+json'),
        'www-authenticate': 'Bearer',
      },
      body: { code: 'INVALID_API_KEY', requestId: expect.any(String) },
    });

    const forbidden = await request(app.getHttpServer())
      .post('/v1/usage-events')
      .set('Authorization', `Bearer ${noScopeSecret}`)
      .set('Content-Type', 'application/json')
      .send('{');
    expect(forbidden).toMatchObject({
      status: 403,
      body: { code: 'INSUFFICIENT_SCOPE', requestId: expect.any(String) },
    });

    const missingIdempotency = await request(app.getHttpServer())
      .post('/v1/usage-events')
      .set('Authorization', `Bearer ${managerSecret}`)
      .set('Content-Type', 'application/json')
      .send({ units: 1 });
    expect(missingIdempotency).toMatchObject({
      status: 400,
      body: {
        code: 'VALIDATION_ERROR',
        errors: [
          {
            field: 'Idempotency-Key',
            reason: expect.any(String),
          },
        ],
        requestId: expect.any(String),
      },
    });

    for (const response of [unauthorized, forbidden, missingIdempotency]) {
      expect(response.body.requestId).toBe(response.headers['x-request-id']);
    }
  });

  it('validates raw idempotency fields before media and body then validates JSON', async () => {
    const valid = '64f4ce08-03df-40fa-ae44-ebd9d584781f';
    for (const invalid of [
      '',
      `${valid},${valid}`,
      valid.toUpperCase(),
      '64f4ce08-03df-10fa-ae44-ebd9d584781f',
      `{${valid}}`,
    ]) {
      const response = await request(app.getHttpServer())
        .post('/v1/usage-events')
        .set('Authorization', `Bearer ${managerSecret}`)
        .set('Idempotency-Key', invalid)
        .set('Content-Type', 'text/plain')
        .send('not-json');
      expect(response).toMatchObject({
        status: 400,
        body: { code: 'VALIDATION_ERROR' },
      });
    }

    const media = await post(valid)
      .set('Content-Type', 'text/plain')
      .send('not-json');
    expect(media).toMatchObject({
      status: 415,
      body: { code: 'UNSUPPORTED_MEDIA_TYPE' },
    });

    const malformed = await post(valid)
      .set('Content-Type', 'application/json')
      .send('{');
    expect(malformed).toMatchObject({
      status: 400,
      body: { code: 'VALIDATION_ERROR' },
    });
  });

  it.each([
    [
      'identical',
      '64f4ce08-03df-40fa-ae44-ebd9d5847827',
      '64f4ce08-03df-40fa-ae44-ebd9d5847827',
    ],
    [
      'different',
      '64f4ce08-03df-40fa-ae44-ebd9d5847828',
      '64f4ce08-03df-40fa-ae44-ebd9d5847829',
    ],
  ])(
    'rejects %s duplicate Idempotency-Key fields on the HTTP wire before parsing the body',
    async (_kind, first, second) => {
      const response = await postWithDuplicateRawIdempotencyKeys(first, second);

      expect(response).toMatchObject({
        status: 400,
        headers: {
          'content-type': expect.stringContaining('application/problem+json'),
        },
        body: {
          code: 'VALIDATION_ERROR',
          errors: [
            {
              field: 'Idempotency-Key',
              reason: expect.any(String),
            },
          ],
          requestId: expect.any(String),
        },
      });
      expect(response.body.requestId).toBe(response.headers['x-request-id']);
    },
  );

  it('keeps wrong methods and descendants parser-before 404', async () => {
    for (const response of await Promise.all([
      request(app.getHttpServer())
        .patch('/v1/usage-events')
        .set('Content-Type', 'application/json')
        .send('{'),
      request(app.getHttpServer())
        .post('/v1/usage-events/child')
        .set('Content-Type', 'application/json')
        .send('{'),
      request(app.getHttpServer())
        .delete('/v1/usage-events/child/grandchild')
        .set('Content-Type', 'application/json')
        .send('{'),
    ])) {
      expect(response).toMatchObject({
        status: 404,
        body: { code: 'ROUTE_NOT_FOUND', requestId: expect.any(String) },
      });
      expect(response.headers['www-authenticate']).toBeUndefined();
      expect(response.body.requestId).toBe(response.headers['x-request-id']);
    }
  });

  it('rejects missing, malformed, out-of-range, and unknown usage fields', async () => {
    const requests = [
      post('64f4ce08-03df-40fa-ae44-ebd9d5847820').set(
        'Content-Type',
        'application/json',
      ),
      post('64f4ce08-03df-40fa-ae44-ebd9d5847821').send({}),
      post('64f4ce08-03df-40fa-ae44-ebd9d5847822').send({ units: 0 }),
      post('64f4ce08-03df-40fa-ae44-ebd9d5847823').send({ units: 10_001 }),
      post('64f4ce08-03df-40fa-ae44-ebd9d5847824').send({ units: 1.5 }),
      post('64f4ce08-03df-40fa-ae44-ebd9d5847825').send({ units: '1' }),
      post('64f4ce08-03df-40fa-ae44-ebd9d5847826').send({
        extra: true,
        units: 1,
      }),
    ];

    for (const response of await Promise.all(requests)) {
      expect(response).toMatchObject({
        status: 400,
        headers: {
          'content-type': expect.stringContaining('application/problem+json'),
        },
        body: { code: 'VALIDATION_ERROR', requestId: expect.any(String) },
      });
      expect(response.body.requestId).toBe(response.headers['x-request-id']);
    }
  });

  it('returns and replays identical accepted terminal bodies and quota headers', async () => {
    const key = '64f4ce08-03df-40fa-ae44-ebd9d584781a';
    const first = await post(key).send({ units: 2 });
    const replay = await post(key).send({ units: 2 });

    expect(first).toMatchObject({
      status: 200,
      headers: {
        'content-type': expect.stringContaining('application/json'),
        'x-quota-limit': '3',
        'x-quota-remaining': '1',
        'x-quota-reset': expect.stringMatching(/^\d+$/),
      },
      body: {
        decision: 'ACCEPTED',
        eventId: expect.any(String),
        quota: { limit: 3, remaining: 1, resetAt: expect.stringMatching(/Z$/) },
        units: 2,
        usageDate: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
      },
    });
    expect(Object.keys(first.body).sort()).toEqual([
      'decision',
      'eventId',
      'quota',
      'units',
      'usageDate',
    ]);
    expect(Object.keys(first.body.quota).sort()).toEqual([
      'limit',
      'remaining',
      'resetAt',
    ]);
    expect(first.headers['retry-after']).toBeUndefined();
    expect(replay.headers['retry-after']).toBeUndefined();
    expect(replay.body).toEqual(first.body);
    expect(replay.headers['x-quota-limit']).toBe(
      first.headers['x-quota-limit'],
    );
    expect(replay.headers['x-quota-remaining']).toBe(
      first.headers['x-quota-remaining'],
    );
    expect(replay.headers['x-quota-reset']).toBe(
      first.headers['x-quota-reset'],
    );
    expect(replay.headers['x-request-id']).not.toBe(
      first.headers['x-request-id'],
    );
    expect(first.headers['x-quota-reset']).toBe(
      String(
        Math.floor(Date.parse(first.body.quota.resetAt as string) / 1_000),
      ),
    );
  });

  it('returns and replays a 429 terminal with fresh requestId and exact safe extensions', async () => {
    await post('64f4ce08-03df-40fa-ae44-ebd9d584781c').send({ units: 2 });
    const key = '64f4ce08-03df-40fa-ae44-ebd9d584781b';
    const first = await post(key).send({ units: 2 });
    const replay = await post(key).send({ units: 2 });

    expect(first).toMatchObject({
      status: 429,
      headers: {
        'content-type': expect.stringContaining('application/problem+json'),
        'x-quota-limit': '3',
        'x-quota-remaining': '1',
        'x-quota-reset': expect.stringMatching(/^\d+$/),
      },
      body: {
        code: 'QUOTA_EXCEEDED',
        decision: 'QUOTA_EXCEEDED',
        eventId: expect.any(String),
        quota: { limit: 3, remaining: 1, resetAt: expect.stringMatching(/Z$/) },
        requestId: expect.any(String),
        status: 429,
        units: 2,
        usageDate: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
      },
    });
    expect(first.headers['retry-after']).toBeUndefined();
    expect(replay.headers['retry-after']).toBeUndefined();
    expect(Object.keys(first.body).sort()).toEqual([
      'code',
      'decision',
      'detail',
      'eventId',
      'quota',
      'requestId',
      'status',
      'title',
      'type',
      'units',
      'usageDate',
    ]);
    expect({ ...replay.body, requestId: first.body.requestId }).toEqual(
      first.body,
    );
    expect(first.body.requestId).toBe(first.headers['x-request-id']);
    expect(replay.body.requestId).toBe(replay.headers['x-request-id']);
    expect(replay.body.requestId).not.toBe(first.body.requestId);
    expect(replay.headers['x-quota-limit']).toBe(
      first.headers['x-quota-limit'],
    );
    expect(replay.headers['x-quota-remaining']).toBe(
      first.headers['x-quota-remaining'],
    );
    expect(replay.headers['x-quota-reset']).toBe(
      first.headers['x-quota-reset'],
    );
    expect(first.headers['x-quota-reset']).toBe(
      String(
        Math.floor(Date.parse(first.body.quota.resetAt as string) / 1_000),
      ),
    );
  });

  it('returns 409 for a changed payload and leaves the accepted snapshot unchanged', async () => {
    const key = '64f4ce08-03df-40fa-ae44-ebd9d584781a';
    await post(key).send({ units: 2 });
    const collision = await post(key).send({ units: 1 });
    const replay = await post(key).send({ units: 2 });

    expect(collision).toMatchObject({
      status: 409,
      body: { code: 'IDEMPOTENCY_KEY_REUSED' },
    });
    expect(collision.headers['x-quota-limit']).toBeUndefined();
    expect(replay).toMatchObject({
      status: 200,
      body: { decision: 'ACCEPTED', quota: { remaining: 1 }, units: 2 },
    });
  });
});

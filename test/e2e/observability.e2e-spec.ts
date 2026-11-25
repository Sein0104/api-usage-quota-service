import type { INestApplication } from '@nestjs/common';
import { jest } from '@jest/globals';
import { Test } from '@nestjs/testing';
import pino, { type DestinationStream, type Logger } from 'pino';
import { PinoLogger } from 'nestjs-pino';
import {
  type IncomingHttpHeaders,
  request as sendHttpRequest,
} from 'node:http';
import type { AddressInfo } from 'node:net';
import request from 'supertest';
import { AppModule } from '../../src/app.module.js';
import { configureApplication } from '../../src/main.js';
import { configureOpenApi } from '../../src/openapi.js';
import { MetricsService } from '../../src/observability/metrics.service.js';
import { SAFE_APPLICATION_LOGGER_ROOT } from '../../src/observability/safe-application-logger.js';
import { testEnvironment } from '../support/test-environment.js';

describe('observability and documentation routes', () => {
  const metricsToken = 'm'.repeat(43);
  const systemAdminToken = 's'.repeat(43);

  async function application(swaggerEnabled: boolean, safeRoot?: Logger) {
    const environment = testEnvironment({
      METRICS_TOKEN: metricsToken,
      SWAGGER_ENABLED: swaggerEnabled,
      SYSTEM_ADMIN_TOKEN: systemAdminToken,
    });
    const builder = Test.createTestingModule({
      imports: [AppModule.forRoot(environment)],
    });
    if (safeRoot !== undefined) {
      builder
        .overrideProvider(SAFE_APPLICATION_LOGGER_ROOT)
        .useValue(() => safeRoot);
    }
    const module = await builder.compile();
    const app = module.createNestApplication();
    configureApplication(app);
    configureOpenApi(app, environment);
    await app.listen(0, '127.0.0.1');
    return app;
  }

  interface RawResponse {
    body: Record<string, unknown>;
    headers: IncomingHttpHeaders;
    status: number;
  }

  function expectRouteNotFound(response: {
    body: Record<string, unknown>;
    headers: Record<string, string | undefined>;
    status: number;
  }): void {
    expect(response.status).toBe(404);
    expect(response.headers['content-type']).toContain(
      'application/problem+json',
    );
    expect(response.headers['x-request-id']).toEqual(expect.any(String));
    expect(response.body).toEqual({
      code: 'ROUTE_NOT_FOUND',
      detail: 'The requested route was not found.',
      requestId: response.headers['x-request-id'],
      status: 404,
      title: 'Route not found',
      type: 'urn:api-usage-quota-service:problem:route-not-found',
    });
  }

  function rawMetricsRequest(
    app: INestApplication,
    authorizationValues: string[],
  ): Promise<RawResponse> {
    const address = app.getHttpServer().address() as
      AddressInfo | string | null;
    if (address === null || typeof address === 'string') {
      throw new Error('The E2E HTTP server must listen on a TCP port.');
    }
    const headers = authorizationValues.flatMap((value) => [
      'Authorization',
      value,
    ]);
    headers.push('Host', `127.0.0.1:${address.port}`, 'Connection', 'close');
    return new Promise((resolve, reject) => {
      const outgoing = sendHttpRequest(
        {
          headers,
          host: '127.0.0.1',
          method: 'GET',
          path: '/metrics',
          port: address.port,
        },
        (response) => {
          let rawBody = '';
          response.setEncoding('utf8');
          response.on('data', (chunk: string) => {
            rawBody += chunk;
          });
          response.on('end', () => {
            try {
              resolve({
                body: JSON.parse(rawBody) as Record<string, unknown>,
                headers: response.headers,
                status: response.statusCode ?? 0,
              });
            } catch (error) {
              reject(error as Error);
            }
          });
        },
      );
      outgoing.once('error', reject);
      outgoing.setTimeout(10_000, () => {
        outgoing.destroy(new Error('Raw metrics request timed out.'));
      });
      outgoing.end();
    });
  }

  it('protects metrics with only its own token and exposes the shared registry', async () => {
    const logLines: string[] = [];
    const destination: DestinationStream = {
      write(chunk: string) {
        logLines.push(chunk);
      },
    };
    const app = await application(
      false,
      pino({ base: null, timestamp: false }, destination),
    );
    try {
      for (const authorization of [
        undefined,
        `Bearer ${systemAdminToken}`,
        `Bearer mq_11111111-2222-4333-8444-555555555555.${'a'.repeat(43)}`,
      ]) {
        let query = request(app.getHttpServer()).get('/metrics');
        if (authorization !== undefined)
          query = query.set('Authorization', authorization);
        const response = await query;
        expect(response.status).toBe(401);
        expect(response.body.code).toBe('INVALID_METRICS_TOKEN');
        expect(response.headers['www-authenticate']).toBe('Bearer');
      }

      const earlyAuthenticationFailure = await request(app.getHttpServer())
        .get('/metrics?token=query-log-canary')
        .set('Authorization', 'Bearer authorization-log-canary');
      expect(earlyAuthenticationFailure.status).toBe(401);
      const requestId = earlyAuthenticationFailure.headers[
        'x-request-id'
      ] as string;
      expect(requestId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      );
      const rawCompletionLine = logLines.find((line) =>
        line.includes(`"request_id":"${requestId}"`),
      );
      expect(rawCompletionLine).toBeDefined();
      expect(rawCompletionLine?.match(/"request_id"/g)).toHaveLength(1);
      expect(rawCompletionLine).not.toContain('query-log-canary');
      expect(rawCompletionLine).not.toContain('authorization-log-canary');
      expect(JSON.parse(rawCompletionLine ?? '{}')).toEqual({
        duration: expect.any(Number),
        level: 30,
        msg: 'request completed',
        outcome: 'CLIENT_ERROR',
        request_id: requestId,
        route: 'GET /metrics',
        status: 401,
      });

      await request(app.getHttpServer()).get('/health/live').expect(200);
      const response = await request(app.getHttpServer())
        .get('/metrics')
        .set('Authorization', `Bearer ${metricsToken}`);
      expect(response.status).toBe(200);
      expect(response.headers['content-type']).toBe(
        app.get(MetricsService).contentType,
      );
      expect(response.headers['www-authenticate']).toBeUndefined();
      expect(response.headers['x-request-id']).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      );
      expect(response.text).toContain(
        'http_requests_total{route="GET /health/live",status="200"} 1',
      );
      expect(response.text).not.toContain(metricsToken);
      expect(app.get(MetricsService)).toBeInstanceOf(MetricsService);
    } finally {
      await app.close();
    }
  });

  it.each([
    ['Basic', [`Basic ${metricsToken}`]],
    ['bare', [metricsToken]],
    ['extra credential space', [`Bearer  ${metricsToken}`]],
    ['credential suffix space', [`Bearer ${metricsToken} extra`]],
    ['duplicate same', [`Bearer ${metricsToken}`, `Bearer ${metricsToken}`]],
    [
      'duplicate different',
      [`Bearer ${metricsToken}`, `Bearer ${'x'.repeat(43)}`],
    ],
  ])('rejects %s Authorization on the raw HTTP wire', async (_kind, values) => {
    const app = await application(false);
    try {
      const response = await rawMetricsRequest(app, values);
      expect(response).toEqual({
        body: {
          code: 'INVALID_METRICS_TOKEN',
          detail: 'The metrics token is invalid.',
          requestId: expect.any(String),
          status: 401,
          title: 'Invalid metrics token',
          type: 'urn:api-usage-quota-service:problem:invalid-metrics-token',
        },
        headers: expect.objectContaining({
          'content-type': expect.stringContaining('application/problem+json'),
          'www-authenticate': 'Bearer',
          'x-request-id': expect.any(String),
        }),
        status: 401,
      });
      expect(response.body.requestId).toBe(response.headers['x-request-id']);
    } finally {
      await app.close();
    }
  });

  it('registers only /docs and /openapi.json when enabled and no raw routes', async () => {
    const app = await application(true);
    try {
      const docs = await Promise.all(
        ['/docs', '/docs/'].map((path) =>
          request(app.getHttpServer()).get(path),
        ),
      );
      const json = await request(app.getHttpServer()).get('/openapi.json');
      for (const response of docs) {
        expect(response.status).toBe(200);
        expect(response.headers['content-type']).toContain('text/html');
        expect(response.headers['x-request-id']).toEqual(expect.any(String));
      }
      expect(json.status).toBe(200);
      expect(json.headers['content-type']).toContain('application/json');
      expect(json.headers['x-request-id']).toEqual(expect.any(String));
      expect(json.body.paths).toHaveProperty('/v1/usage-events');
      for (const path of ['/docs-json', '/docs-yaml']) {
        const response = await request(app.getHttpServer()).get(path);
        expectRouteNotFound(response);
      }
    } finally {
      await app.close();
    }
  });

  it('leaves documentation routes unregistered when disabled', async () => {
    const app = await application(false);
    try {
      for (const path of [
        '/docs',
        '/docs/',
        '/openapi.json',
        '/docs-json',
        '/docs-yaml',
      ]) {
        const response = await request(app.getHttpServer()).get(path);
        expectRouteNotFound(response);
      }
    } finally {
      await app.close();
    }
  });

  it('rejects documentation wrong methods and descendants before credentials matter', async () => {
    const app = await application(true);
    try {
      const probes = [
        request(app.getHttpServer())
          .post('/docs')
          .set('Authorization', 'Bearer definitely-not-a-valid-credential')
          .send({ ignored: true }),
        request(app.getHttpServer())
          .post('/openapi.json')
          .set('Authorization', 'Bearer definitely-not-a-valid-credential')
          .send({ ignored: true }),
        request(app.getHttpServer())
          .get('/docs/child')
          .set('Authorization', 'Bearer definitely-not-a-valid-credential'),
        request(app.getHttpServer())
          .get('/openapi.json/child')
          .set('Authorization', 'Bearer definitely-not-a-valid-credential'),
      ];
      for (const probe of probes) {
        expectRouteNotFound(await probe);
      }
    } finally {
      await app.close();
    }
  });

  it('resolves the configured Pino root lazily after LoggerModule initialization', async () => {
    const app = await application(false);
    const info = jest.spyOn(PinoLogger.root, 'info');
    try {
      const response = await request(app.getHttpServer()).get('/metrics');
      expect(response.status).toBe(401);
      expect(info).toHaveBeenCalledWith(
        expect.objectContaining({
          request_id: response.headers['x-request-id'],
          route: 'GET /metrics',
          status: 401,
        }),
        'request completed',
      );
    } finally {
      info.mockRestore();
      await app.close();
    }
  });
});

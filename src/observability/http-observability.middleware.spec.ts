import { EventEmitter } from 'node:events';
import { jest } from '@jest/globals';
import { MetricsService } from './metrics.service.js';
import { HttpObservabilityMiddleware } from './http-observability.middleware.js';

describe('HttpObservabilityMiddleware', () => {
  it('records and logs one safe completion without raw URL or credentials', async () => {
    const metrics = new MetricsService();
    const logger = { requestCompleted: jest.fn() };
    const middleware = new HttpObservabilityMiddleware(
      metrics,
      logger as never,
    );
    const response = Object.assign(new EventEmitter(), { statusCode: 200 });
    const request = {
      method: 'GET',
      originalUrl: '/v1/api-keys?cursor=sensitive',
      requestContext: {
        receivedAt: new Date(),
        requestId: '11111111-2222-4333-8444-555555555555',
      },
    };
    const next = jest.fn();

    middleware.use(request as never, response as never, next);
    response.emit('finish');
    response.emit('finish');

    expect(next).toHaveBeenCalledTimes(1);
    expect(logger.requestCompleted).toHaveBeenCalledTimes(1);
    expect(logger.requestCompleted.mock.calls[0]?.[0]).toEqual({
      duration: expect.any(Number),
      outcome: 'SUCCESS',
      requestId: '11111111-2222-4333-8444-555555555555',
      route: 'GET /v1/api-keys',
      status: 200,
    });
    expect(JSON.stringify(logger.requestCompleted.mock.calls)).not.toContain(
      'sensitive',
    );
    expect(await metrics.exposition()).toContain(
      'http_requests_total{route="GET /v1/api-keys",status="200"} 1',
    );
  });

  it('contains completion-observer failures instead of crashing the process', () => {
    const middleware = new HttpObservabilityMiddleware(
      {
        observeHttp: () => {
          throw new Error('metrics failed');
        },
      } as never,
      {
        requestCompleted: () => {
          throw new Error('logging failed');
        },
      } as never,
    );
    const response = Object.assign(new EventEmitter(), { statusCode: 500 });

    middleware.use(
      {
        method: 'GET',
        originalUrl: '/health/live',
        requestContext: {
          receivedAt: new Date(),
          requestId: '11111111-2222-4333-8444-555555555555',
        },
      } as never,
      response as never,
      () => undefined,
    );

    expect(() => response.emit('finish')).not.toThrow();
  });
});

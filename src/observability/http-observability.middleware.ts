import { Injectable, type NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { canonicalHttpRoute, MetricsService } from './metrics.service.js';
import { SafeApplicationLogger } from './safe-application-logger.js';

type RequestOutcome = 'SUCCESS' | 'CLIENT_ERROR' | 'SERVER_ERROR';

function outcome(statusCode: number): RequestOutcome {
  if (statusCode >= 500) return 'SERVER_ERROR';
  if (statusCode >= 400) return 'CLIENT_ERROR';
  return 'SUCCESS';
}

@Injectable()
export class HttpObservabilityMiddleware implements NestMiddleware {
  constructor(
    private readonly metrics: MetricsService,
    private readonly logger: SafeApplicationLogger,
  ) {}

  use(request: Request, response: Response, next: NextFunction): void {
    const startedAt = process.hrtime.bigint();
    const route = canonicalHttpRoute(request.method, request.originalUrl);
    response.once('finish', () => {
      const duration =
        Number(process.hrtime.bigint() - startedAt) / 1_000_000_000;
      try {
        this.metrics.observeHttp(
          request.method,
          request.originalUrl,
          response.statusCode,
          duration,
        );
      } catch {
        // Observability must not fail a completed HTTP request.
      }
      try {
        this.logger.requestCompleted({
          duration,
          outcome: outcome(response.statusCode),
          requestId: request.requestContext?.requestId ?? 'unavailable',
          route,
          status: response.statusCode,
        });
      } catch {
        // Observability must not crash the process after the response finishes.
      }
    });
    next();
  }
}

import { Inject, Injectable } from '@nestjs/common';
import type { Logger } from 'pino';
import type { HttpRoute } from './metrics.service.js';

export const SAFE_APPLICATION_LOGGER_ROOT = Symbol(
  'SAFE_APPLICATION_LOGGER_ROOT',
);
export type SafeApplicationLoggerRoot = () => Logger;

export interface CompletedRequestLog {
  duration: number;
  outcome: 'SUCCESS' | 'CLIENT_ERROR' | 'SERVER_ERROR';
  requestId: string;
  route: HttpRoute;
  status: number;
}

@Injectable()
export class SafeApplicationLogger {
  constructor(
    @Inject(SAFE_APPLICATION_LOGGER_ROOT)
    private readonly root: SafeApplicationLoggerRoot,
  ) {}

  requestCompleted(fields: CompletedRequestLog): void {
    this.root().info(
      {
        duration: fields.duration,
        outcome: fields.outcome,
        request_id: fields.requestId,
        route: fields.route,
        status: fields.status,
      },
      'request completed',
    );
  }
}

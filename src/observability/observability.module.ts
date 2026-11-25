import { Global, Module } from '@nestjs/common';
import { LoggerModule, PinoLogger } from 'nestjs-pino';
import { METRICS_TOKEN } from '../common/security/security.tokens.js';
import { ENVIRONMENT } from '../config/environment.module.js';
import type { Environment } from '../config/environment.schema.js';
import type { IncomingMessage } from 'node:http';
import { HttpObservabilityMiddleware } from './http-observability.middleware.js';
import { MetricsController } from './metrics.controller.js';
import { MetricsService } from './metrics.service.js';
import { MetricsTokenGuard } from './metrics-token.guard.js';
import {
  SAFE_APPLICATION_LOGGER_ROOT,
  SafeApplicationLogger,
} from './safe-application-logger.js';

@Global()
@Module({
  controllers: [MetricsController],
  exports: [HttpObservabilityMiddleware, MetricsService, SafeApplicationLogger],
  imports: [
    LoggerModule.forRootAsync({
      inject: [ENVIRONMENT],
      useFactory: (environment: Environment) => ({
        pinoHttp: {
          autoLogging: false,
          customAttributeKeys: {
            reqId: 'request_id',
          },
          level: environment.LOG_LEVEL,
          quietReqLogger: true,
          quietResLogger: true,
          genReqId: (request: IncomingMessage) =>
            (
              request as IncomingMessage & {
                requestContext?: { requestId?: string };
              }
            ).requestContext?.requestId ?? 'pending-request-id',
          serializers: {
            req: (request: { id?: unknown }) => ({ id: request.id }),
            res: () => ({}),
          },
          redact: {
            paths: [
              'req.headers.authorization',
              'req.rawHeaders',
              'request.headers.authorization',
              'request.rawHeaders',
              'authorization',
              '*.authorization',
              'secret',
              '*.secret',
              'plaintext',
              '*.plaintext',
              'digest',
              '*.digest',
              'token',
              '*.token',
              'secretDigest',
              '*.secretDigest',
              'METRICS_TOKEN',
              '*.METRICS_TOKEN',
              'SYSTEM_ADMIN_TOKEN',
              '*.SYSTEM_ADMIN_TOKEN',
              'API_KEY_PEPPER',
              '*.API_KEY_PEPPER',
              'DATABASE_URL',
              '*.DATABASE_URL',
            ],
            censor: '[REDACTED]',
          },
        },
      }),
    }),
  ],
  providers: [
    {
      inject: [ENVIRONMENT],
      provide: METRICS_TOKEN,
      useFactory: (environment: Environment) => environment.METRICS_TOKEN,
    },
    MetricsService,
    MetricsTokenGuard,
    {
      inject: [PinoLogger],
      provide: SAFE_APPLICATION_LOGGER_ROOT,
      useFactory: () => () => PinoLogger.root,
    },
    SafeApplicationLogger,
    HttpObservabilityMiddleware,
  ],
})
export class ObservabilityModule {}

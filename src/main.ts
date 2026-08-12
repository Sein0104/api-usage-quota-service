import {
  type INestApplication,
  RequestMethod,
  ValidationPipe,
  type ValidationError,
} from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NextFunction, Request, Response } from 'express';
import { pathToFileURL } from 'node:url';
import { AppModule } from './app.module.js';
import { ProblemDetailsFilter } from './common/http/problem-details.filter.js';
import { ProblemCode } from './common/http/problem-code.js';
import { ProblemException } from './common/http/problem.exception.js';
import { requestIdMiddleware } from './common/http/request-id.middleware.js';
import { validateEnvironment } from './config/environment.schema.js';
import { SystemAdminAuthenticator } from './system-admin/system-admin-authenticator.service.js';
import { isSystemAdminProjectBootstrapRequest } from './system-admin/system-admin-route.matcher.js';

function toValidationErrors(
  errors: ValidationError[],
): { field: string; reason: string }[] {
  return errors.map((error) => ({
    field: error.property,
    reason: Object.values(error.constraints ?? {}).join(', '),
  }));
}

export function configureApplication(app: INestApplication): void {
  app.use(requestIdMiddleware);
  // This unmounted matcher avoids Express prefix-mount semantics so only the
  // real operation authenticates before JSON parsing; unknown routes stay 404.
  app.use((request: Request, response: Response, next: NextFunction) => {
    if (isSystemAdminProjectBootstrapRequest(request)) {
      app.get(SystemAdminAuthenticator).middleware(request, response, next);
      return;
    }
    next();
  });
  app.setGlobalPrefix('v1', {
    exclude: [
      { path: 'health/live', method: RequestMethod.GET },
      { path: 'health/ready', method: RequestMethod.GET },
    ],
  });
  app.useGlobalPipes(
    new ValidationPipe({
      exceptionFactory: (errors) =>
        new ProblemException({
          code: ProblemCode.VALIDATION_ERROR,
          detail: 'Request validation failed.',
          errors: toValidationErrors(errors),
          status: 400,
          title: 'Validation failed',
        }),
      forbidNonWhitelisted: true,
      transform: true,
      whitelist: true,
    }),
  );
  app.useGlobalFilters(new ProblemDetailsFilter());
}

async function bootstrap(): Promise<void> {
  const environment = validateEnvironment(process.env);
  const app = await NestFactory.create(AppModule.forRoot(environment));

  configureApplication(app);
  app.enableShutdownHooks();
  await app.listen(environment.PORT);
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  void bootstrap();
}

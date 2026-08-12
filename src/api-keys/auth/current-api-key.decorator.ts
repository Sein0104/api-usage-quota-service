import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';
import { getTrustedApiKey } from './api-key-request-principal.js';
import type { AuthenticatedApiKey } from './authenticated-api-key.js';

export const CurrentApiKey = createParamDecorator(
  (
    _data: unknown,
    context: ExecutionContext,
  ): AuthenticatedApiKey | undefined =>
    getTrustedApiKey(context.switchToHttp().getRequest<Request>()),
);

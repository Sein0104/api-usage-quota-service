import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import type { RequestContext } from './request-context.js';

export function requestIdMiddleware(
  request: Request,
  response: Response,
  next: NextFunction,
): void {
  const requestContext: RequestContext = { requestId: randomUUID() };

  request.requestContext = requestContext;
  response.setHeader('X-Request-Id', requestContext.requestId);
  next();
}

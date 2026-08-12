import { Injectable } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { parseBearerCredential } from '../common/auth/bearer-credential.parser.js';
import { ProblemCode } from '../common/http/problem-code.js';
import { ProblemException } from '../common/http/problem.exception.js';
import { attachAuthenticatedApiKey } from './auth/api-key-request-principal.js';
import { ApiKeyAuthService } from './auth/api-key-auth.service.js';
import type { ApiScope } from './api-key.scopes.js';

@Injectable()
export class ApiKeyEarlyAuthorizer {
  constructor(private readonly authenticator: ApiKeyAuthService) {}

  readonly middleware = async (
    request: Request,
    _response: Response,
    next: NextFunction,
  ): Promise<void> => this.authorize(request, _response, next, ['keys:manage']);

  async authorize(
    request: Request,
    _response: Response,
    next: NextFunction,
    requiredScopes: readonly ApiScope[],
  ): Promise<void> {
    try {
      const principal = await this.authenticator.authenticate(
        parseBearerCredential(request.rawHeaders),
      );
      if (!requiredScopes.every((scope) => principal.scopes.includes(scope))) {
        throw new ProblemException({
          code: ProblemCode.INSUFFICIENT_SCOPE,
          detail: 'The API key does not have the required scope.',
          status: 403,
          title: 'Insufficient scope',
        });
      }
      attachAuthenticatedApiKey(request, principal);
      next();
    } catch (error) {
      next(error);
    }
  }
}

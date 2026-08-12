import {
  type CanActivate,
  type ExecutionContext,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { ProblemCode } from '../../common/http/problem-code.js';
import { ProblemException } from '../../common/http/problem.exception.js';
import type { ApiScope } from '../api-key.scopes.js';
import { getTrustedApiKey } from './api-key-request-principal.js';
import { REQUIRED_SCOPES } from './required-scopes.decorator.js';

@Injectable()
export class ScopesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<readonly ApiScope[]>(
      REQUIRED_SCOPES,
      [context.getHandler(), context.getClass()],
    );
    if (required === undefined || required.length === 0) {
      return true;
    }
    const request = context.switchToHttp().getRequest<Request>();
    const principal = getTrustedApiKey(request);
    if (
      principal !== undefined &&
      required.every((scope) => principal.scopes.includes(scope))
    ) {
      return true;
    }
    throw new ProblemException({
      code: ProblemCode.INSUFFICIENT_SCOPE,
      detail: 'The API key does not have the required scope.',
      status: 403,
      title: 'Insufficient scope',
    });
  }
}

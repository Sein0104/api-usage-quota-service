import { Inject, Injectable } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { parseBearerCredential } from '../common/auth/bearer-credential.parser.js';
import { timingSafeSecretEqual } from '../common/auth/timing-safe-secret.js';
import { ProblemCode } from '../common/http/problem-code.js';
import { ProblemException } from '../common/http/problem.exception.js';
import { SYSTEM_ADMIN_TOKEN } from '../common/security/security.tokens.js';

@Injectable()
export class SystemAdminAuthenticator {
  constructor(@Inject(SYSTEM_ADMIN_TOKEN) private readonly token: string) {}

  authenticate(request: Pick<Request, 'rawHeaders'>): void {
    const credential = parseBearerCredential(request.rawHeaders);
    if (
      credential === undefined ||
      !timingSafeSecretEqual(credential, this.token)
    ) {
      throw new ProblemException({
        code: ProblemCode.INVALID_SYSTEM_ADMIN_TOKEN,
        detail: 'The system administrator credential is invalid.',
        headers: { 'WWW-Authenticate': 'Bearer' },
        status: 401,
        title: 'Invalid system administrator token',
      });
    }
  }

  readonly middleware = (
    request: Request,
    _response: Response,
    next: NextFunction,
  ): void => {
    try {
      this.authenticate(request);
      next();
    } catch (error) {
      next(error);
    }
  };
}

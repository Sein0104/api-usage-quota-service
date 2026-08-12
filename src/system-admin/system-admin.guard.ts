import {
  type CanActivate,
  type ExecutionContext,
  Inject,
  Injectable,
} from '@nestjs/common';
import type { Request } from 'express';
import { parseBearerCredential } from '../common/auth/bearer-credential.parser.js';
import { timingSafeSecretEqual } from '../common/auth/timing-safe-secret.js';
import { SYSTEM_ADMIN_TOKEN } from '../common/security/security.tokens.js';
import { ProblemCode } from '../common/http/problem-code.js';
import { ProblemException } from '../common/http/problem.exception.js';

@Injectable()
export class SystemAdminGuard implements CanActivate {
  constructor(@Inject(SYSTEM_ADMIN_TOKEN) private readonly token: string) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();
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

    return true;
  }
}

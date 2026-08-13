import {
  CanActivate,
  ExecutionContext,
  Inject,
  Injectable,
} from '@nestjs/common';
import type { Request } from 'express';
import { parseBearerCredential } from '../common/auth/bearer-credential.parser.js';
import { timingSafeSecretEqual } from '../common/auth/timing-safe-secret.js';
import { ProblemCode } from '../common/http/problem-code.js';
import { ProblemException } from '../common/http/problem.exception.js';
import { METRICS_TOKEN } from '../common/security/security.tokens.js';

@Injectable()
export class MetricsTokenGuard implements CanActivate {
  constructor(@Inject(METRICS_TOKEN) private readonly token: string) {}

  canActivate(context: ExecutionContext): true {
    const request = context.switchToHttp().getRequest<Request>();
    const candidate = parseBearerCredential(request.rawHeaders);
    if (
      candidate === undefined ||
      !timingSafeSecretEqual(candidate, this.token)
    ) {
      throw new ProblemException({
        code: ProblemCode.INVALID_METRICS_TOKEN,
        detail: 'The metrics token is invalid.',
        headers: { 'WWW-Authenticate': 'Bearer' },
        status: 401,
        title: 'Invalid metrics token',
      });
    }
    return true;
  }
}

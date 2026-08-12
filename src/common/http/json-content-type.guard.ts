import {
  type CanActivate,
  type ExecutionContext,
  Injectable,
} from '@nestjs/common';
import type { Request } from 'express';
import { ProblemCode } from './problem-code.js';
import { ProblemException } from './problem.exception.js';

const bodyMethods = new Set(['POST', 'PUT', 'PATCH']);

@Injectable()
export class JsonContentTypeGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();
    const hasBody =
      request.headers['content-length'] !== undefined ||
      request.headers['transfer-encoding'] !== undefined;

    if (
      request.path.startsWith('/v1') &&
      bodyMethods.has(request.method) &&
      hasBody &&
      !request.is('application/json')
    ) {
      throw new ProblemException({
        code: ProblemCode.UNSUPPORTED_MEDIA_TYPE,
        detail: 'The request media type must be application/json.',
        status: 415,
        title: 'Unsupported media type',
      });
    }

    return true;
  }
}

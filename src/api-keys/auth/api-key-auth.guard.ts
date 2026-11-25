import {
  type CanActivate,
  type ExecutionContext,
  Injectable,
} from '@nestjs/common';
import type { Request } from 'express';
import { parseBearerCredential } from '../../common/auth/bearer-credential.parser.js';
import {
  attachAuthenticatedApiKey,
  getTrustedApiKey,
} from './api-key-request-principal.js';
import { ApiKeyAuthService } from './api-key-auth.service.js';

@Injectable()
export class ApiKeyAuthGuard implements CanActivate {
  constructor(private readonly authenticator: ApiKeyAuthService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request>();
    if (getTrustedApiKey(request) !== undefined) {
      return true;
    }
    const principal = await this.authenticator.authenticate(
      parseBearerCredential(request.rawHeaders),
    );
    attachAuthenticatedApiKey(request, principal);
    return true;
  }
}

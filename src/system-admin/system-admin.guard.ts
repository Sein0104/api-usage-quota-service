import {
  type CanActivate,
  type ExecutionContext,
  Injectable,
} from '@nestjs/common';
import type { Request } from 'express';
import { SystemAdminAuthenticator } from './system-admin-authenticator.service.js';

@Injectable()
export class SystemAdminGuard implements CanActivate {
  constructor(private readonly authenticator: SystemAdminAuthenticator) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();
    this.authenticator.authenticate(request);
    return true;
  }
}

import { SetMetadata } from '@nestjs/common';
import type { ApiScope } from '../api-key.scopes.js';

export const REQUIRED_SCOPES = Symbol('REQUIRED_SCOPES');

export const RequiredScopes = (...scopes: ApiScope[]) =>
  SetMetadata(REQUIRED_SCOPES, scopes);

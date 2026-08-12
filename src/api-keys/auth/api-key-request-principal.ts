import type { Request } from 'express';
import type { AuthenticatedApiKey } from './authenticated-api-key.js';

const trustedRequests = new WeakSet<Request>();

export function attachAuthenticatedApiKey(
  request: Request,
  principal: AuthenticatedApiKey,
): void {
  request.apiKeyPrincipal = principal;
  trustedRequests.add(request);
}

export function getTrustedApiKey(
  request: Request,
): AuthenticatedApiKey | undefined {
  return trustedRequests.has(request) ? request.apiKeyPrincipal : undefined;
}

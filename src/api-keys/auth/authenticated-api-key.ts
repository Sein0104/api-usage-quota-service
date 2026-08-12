import type { ApiScope } from '../api-key.scopes.js';

export interface AuthenticatedApiKey {
  readonly id: string;
  readonly projectId: string;
  readonly scopes: readonly ApiScope[];
}

declare global {
  namespace Express {
    interface Request {
      apiKeyPrincipal?: AuthenticatedApiKey;
    }
  }
}

export {};

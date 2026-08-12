import type { ApiKey } from '../generated/prisma/client.js';

export const INITIAL_ADMIN_SCOPES = [
  'usage:write',
  'usage:read',
  'keys:manage',
  'audit:read',
] as const;

export function presentApiKey(apiKey: ApiKey): {
  id: string;
  name: string;
  prefix: string;
  scopes: string[];
  status: 'ACTIVE' | 'REVOKED';
  createdAt: string;
  revokedAt: string | null;
} {
  return {
    id: apiKey.id,
    name: apiKey.name,
    prefix: apiKey.prefix,
    scopes: [...apiKey.scopes],
    status: apiKey.status,
    createdAt: apiKey.createdAt.toISOString(),
    revokedAt: apiKey.revokedAt?.toISOString() ?? null,
  };
}

export const API_SCOPE_ORDER = [
  'usage:write',
  'usage:read',
  'keys:manage',
  'audit:read',
] as const;

export type ApiScope = (typeof API_SCOPE_ORDER)[number];

export function isApiScope(value: string): value is ApiScope {
  return (API_SCOPE_ORDER as readonly string[]).includes(value);
}

export function canonicalizeApiScopes(scopes: readonly string[]): ApiScope[] {
  return API_SCOPE_ORDER.filter((scope) => scopes.includes(scope));
}

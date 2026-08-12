interface RequestTarget {
  method: string;
  originalUrl: string;
}

const collectionPaths = new Set(['/v1/api-keys', '/v1/api-keys/']);

function pathOf(request: RequestTarget): string {
  return request.originalUrl.split('?', 1)[0].toLowerCase();
}

export function isApiKeyCreateRequest(request: RequestTarget): boolean {
  return request.method === 'POST' && collectionPaths.has(pathOf(request));
}

export interface ApiKeyRoutePolicy {
  requiredScopes: readonly import('./api-key.scopes.js').ApiScope[];
}

export function isApiKeyManagedRequest(request: RequestTarget): boolean {
  const path = pathOf(request);
  return (
    ((request.method === 'POST' || request.method === 'GET') &&
      collectionPaths.has(path)) ||
    (request.method === 'DELETE' && /^\/v1\/api-keys\/[^/]+$/.test(path))
  );
}

export function apiKeyRoutePolicy(
  request: RequestTarget,
): ApiKeyRoutePolicy | null {
  return isApiKeyManagedRequest(request)
    ? { requiredScopes: ['keys:manage'] }
    : null;
}

export function isUnregisteredApiKeyRoute(request: RequestTarget): boolean {
  const path = pathOf(request);
  return (
    !isApiKeyManagedRequest(request) &&
    (path === '/v1/api-keys' || path.startsWith('/v1/api-keys/'))
  );
}

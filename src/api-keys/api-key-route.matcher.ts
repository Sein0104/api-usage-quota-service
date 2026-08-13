interface RequestTarget {
  method: string;
  originalUrl: string;
}

const collectionPaths = new Set(['/v1/api-keys', '/v1/api-keys/']);
const usageEventPaths = new Set(['/v1/usage-events', '/v1/usage-events/']);
const dailyUsagePaths = new Set(['/v1/usage/daily', '/v1/usage/daily/']);

function pathOf(request: RequestTarget): string {
  return request.originalUrl.split('?', 1)[0].toLowerCase();
}

export function isApiKeyCreateRequest(request: RequestTarget): boolean {
  return request.method === 'POST' && collectionPaths.has(pathOf(request));
}

export interface ApiKeyRoutePolicy {
  idempotencyKey?: true;
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
  if (isApiKeyManagedRequest(request)) {
    return { requiredScopes: ['keys:manage'] };
  }
  if (request.method === 'POST' && usageEventPaths.has(pathOf(request))) {
    return { idempotencyKey: true, requiredScopes: ['usage:write'] };
  }
  if (request.method === 'GET' && dailyUsagePaths.has(pathOf(request))) {
    return { requiredScopes: ['usage:read'] };
  }
  return null;
}

export function isUnregisteredApiKeyRoute(request: RequestTarget): boolean {
  const path = pathOf(request);
  return (
    apiKeyRoutePolicy(request) === null &&
    (path === '/v1/api-keys' ||
      path.startsWith('/v1/api-keys/') ||
      path === '/v1/usage-events' ||
      path.startsWith('/v1/usage-events/') ||
      path === '/v1/usage' ||
      path.startsWith('/v1/usage/'))
  );
}

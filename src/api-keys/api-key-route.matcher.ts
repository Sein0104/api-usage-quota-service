interface RequestTarget {
  method: string;
  originalUrl: string;
}

const createPaths = new Set(['/v1/api-keys', '/v1/api-keys/']);

function pathOf(request: RequestTarget): string {
  return request.originalUrl.split('?', 1)[0].toLowerCase();
}

export function isApiKeyCreateRequest(request: RequestTarget): boolean {
  return request.method === 'POST' && createPaths.has(pathOf(request));
}

// Task 5 must replace this catch-all as it registers list/revoke endpoints.
export function isUnregisteredApiKeyRoute(request: RequestTarget): boolean {
  const path = pathOf(request);
  return path === '/v1/api-keys' || path.startsWith('/v1/api-keys/');
}

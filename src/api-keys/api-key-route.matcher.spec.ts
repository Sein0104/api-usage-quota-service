import {
  apiKeyRoutePolicy,
  isApiKeyManagedRequest,
  isUnregisteredApiKeyRoute,
} from './api-key-route.matcher.js';

function request(method: string, originalUrl: string) {
  return { method, originalUrl };
}

describe('API key route policy', () => {
  it.each([
    ['POST', '/v1/api-keys'],
    ['POST', '/v1/api-keys/'],
    ['GET', '/v1/api-keys?limit=10'],
    ['GET', '/v1/api-keys/'],
    ['GET', '/v1/API-KEYS?cursor=broken'],
    ['GET', '/v1/API-KEYS/?cursor=broken'],
    ['DELETE', '/v1/api-keys/11111111-2222-4333-8444-555555555555'],
  ])('authenticates the known %s %s operation', (method, url) => {
    expect(isApiKeyManagedRequest(request(method, url))).toBe(true);
    expect(isUnregisteredApiKeyRoute(request(method, url))).toBe(false);
  });

  it.each([
    ['DELETE', '/v1/api-keys/'],
    ['PATCH', '/v1/api-keys'],
    ['POST', '/v1/api-keys/a/b'],
    ['GET', '/v1/api-keys/a'],
    ['DELETE', '/v1/api-keys/a/b'],
  ])(
    'returns an unauthenticated 404 policy for unknown %s %s',
    (method, url) => {
      expect(isApiKeyManagedRequest(request(method, url))).toBe(false);
      expect(isUnregisteredApiKeyRoute(request(method, url))).toBe(true);
    },
  );

  it('returns operation-specific scopes through a reusable policy boundary', () => {
    expect(apiKeyRoutePolicy(request('GET', '/v1/api-keys'))).toEqual({
      requiredScopes: ['keys:manage'],
    });
    expect(apiKeyRoutePolicy(request('GET', '/v1/api-keys/a'))).toBeNull();
  });

  it.each([
    ['POST', '/v1/usage-events'],
    ['POST', '/v1/usage-events/'],
    ['POST', '/v1/USAGE-EVENTS?source=retry'],
  ])('authenticates the exact usage ingest operation %s %s', (method, url) => {
    expect(apiKeyRoutePolicy(request(method, url))).toEqual({
      idempotencyKey: true,
      requiredScopes: ['usage:write'],
    });
    expect(isUnregisteredApiKeyRoute(request(method, url))).toBe(false);
  });

  it.each([
    ['GET', '/v1/usage-events'],
    ['PATCH', '/v1/usage-events/'],
    ['POST', '/v1/usage-events/child'],
    ['DELETE', '/v1/usage-events/child/grandchild'],
  ])('keeps unknown usage routes parser-before 404: %s %s', (method, url) => {
    expect(apiKeyRoutePolicy(request(method, url))).toBeNull();
    expect(isUnregisteredApiKeyRoute(request(method, url))).toBe(true);
  });
});

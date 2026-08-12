import { isSystemAdminProjectBootstrapRequest } from './system-admin-route.matcher.js';

describe('isSystemAdminProjectBootstrapRequest', () => {
  it.each([
    ['POST', '/v1/admin/projects', true],
    ['POST', '/v1/admin/projects/', true],
    ['POST', '/v1/admin/projects?source=test', true],
    ['POST', '/V1/ADMIN/PROJECTS', true],
    ['GET', '/v1/admin/projects', false],
    ['OPTIONS', '/v1/admin/projects', false],
    ['POST', '/v1/admin/projects/not-a-route', false],
  ])(
    'matches only the protected POST operation: %s %s',
    (method, url, expected) => {
      expect(
        isSystemAdminProjectBootstrapRequest({ method, originalUrl: url }),
      ).toBe(expected);
    },
  );
});

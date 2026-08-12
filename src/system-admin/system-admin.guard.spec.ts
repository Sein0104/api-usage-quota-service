import { ProblemException } from '../common/http/problem.exception.js';
import { SystemAdminGuard } from './system-admin.guard.js';

describe('SystemAdminGuard', () => {
  it('rejects missing, malformed, and duplicate Authorization fields before body validation', () => {
    const guard = new SystemAdminGuard('system-admin-token');
    const makeContext = (rawHeaders: string[]) => ({
      switchToHttp: () => ({ getRequest: () => ({ rawHeaders }) }),
    });

    for (const rawHeaders of [
      [],
      ['Authorization', 'Basic abc'],
      [
        'Authorization',
        'Bearer system-admin-token',
        'authorization',
        'Bearer system-admin-token',
      ],
    ]) {
      try {
        guard.canActivate(makeContext(rawHeaders) as never);
        throw new Error('expected an invalid system administrator token');
      } catch (error) {
        expect(error).toBeInstanceOf(ProblemException);
        expect((error as ProblemException).problem).toMatchObject({
          code: 'INVALID_SYSTEM_ADMIN_TOKEN',
          headers: { 'WWW-Authenticate': 'Bearer' },
          status: 401,
        });
      }
    }
  });
});

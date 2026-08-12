import { isDatabaseDependencyError } from './dependency-error.js';

describe('isDatabaseDependencyError', () => {
  it.each([
    [{ code: 'P2037' }],
    [
      {
        code: 'P2010',
        meta: { driverAdapterError: { cause: { originalCode: '08006' } } },
      },
    ],
    [
      {
        code: 'P2039',
        meta: { driverAdapterError: { cause: { originalCode: '57P01' } } },
      },
    ],
  ])('recognizes Prisma availability errors: %o', (error) => {
    expect(isDatabaseDependencyError(error)).toBe(true);
  });

  it.each([
    [
      {
        code: 'P2010',
        meta: { driverAdapterError: { cause: { originalCode: '42601' } } },
      },
    ],
    [
      {
        code: 'P2039',
        meta: { driverAdapterError: { cause: { originalCode: '23505' } } },
      },
    ],
    [{ code: 'P2002' }],
  ])(
    'does not classify query or constraint errors as unavailable: %o',
    (error) => {
      expect(isDatabaseDependencyError(error)).toBe(false);
    },
  );
});

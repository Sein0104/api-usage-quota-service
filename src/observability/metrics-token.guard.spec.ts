import { MetricsTokenGuard } from './metrics-token.guard.js';

function context(rawHeaders: string[]) {
  return {
    switchToHttp: () => ({ getRequest: () => ({ rawHeaders }) }),
  } as never;
}

describe('MetricsTokenGuard', () => {
  const token = 'm'.repeat(43);
  const guard = new MetricsTokenGuard(token);

  it('accepts exactly one canonical Bearer metrics token', () => {
    expect(
      guard.canActivate(context(['Authorization', `Bearer ${token}`])),
    ).toBe(true);
  });

  it.each([
    { rawHeaders: [] },
    { rawHeaders: ['Authorization', `Basic ${token}`] },
    {
      rawHeaders: [
        'Authorization',
        `Bearer ${token}`,
        'Authorization',
        `Bearer ${token}`,
      ],
    },
    { rawHeaders: ['Authorization', `Bearer ${'s'.repeat(43)}`] },
  ])(
    'rejects missing, malformed, duplicate, and foreign credentials',
    ({ rawHeaders }) => {
      expect(() => guard.canActivate(context(rawHeaders))).toThrow();
    },
  );
});

import { parseListDailyUsageQuery } from './list-daily-usage.query.js';

function expectValidation(query: Record<string, unknown>) {
  expect(() => parseListDailyUsageQuery(query)).toThrow(
    expect.objectContaining({
      problem: expect.objectContaining({
        code: 'VALIDATION_ERROR',
        status: 400,
      }),
    }),
  );
}

describe('parseListDailyUsageQuery', () => {
  it('accepts canonical Gregorian dates at the inclusive 90-day boundary', () => {
    expect(
      parseListDailyUsageQuery({ from: '2024-01-01', to: '2024-03-30' }),
    ).toEqual({ from: '2024-01-01', to: '2024-03-30' });
    expect(
      parseListDailyUsageQuery({ from: '2024-02-29', to: '2024-02-29' }),
    ).toEqual({ from: '2024-02-29', to: '2024-02-29' });
  });

  it.each([
    {},
    { from: '', to: '2026-08-01' },
    { from: '2026-08-01', to: '' },
    { from: ['2026-08-01', '2026-08-02'], to: '2026-08-03' },
    { from: '2026-08-01', to: ['2026-08-02', '2026-08-03'] },
    { from: '2026-08-01', to: '2026-08-02', extra: 'x' },
    { from: '2026-8-01', to: '2026-08-02' },
    { from: '2026-08-01T00:00:00.000Z', to: '2026-08-02' },
    { from: '2023-02-29', to: '2023-03-01' },
    { from: '2024-04-31', to: '2024-05-01' },
    { from: '0000-01-01', to: '0000-01-01' },
    { from: '2026-08-02', to: '2026-08-01' },
    { from: '2024-01-01', to: '2024-03-31' },
  ])(
    'rejects malformed, ambiguous, unknown, or invalid ranges: %p',
    (query) => {
      expectValidation(query);
    },
  );
});

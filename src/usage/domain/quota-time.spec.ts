import { quotaTime } from './quota-time.js';

describe('quotaTime', () => {
  it.each([
    ['2026-08-11T23:59:59.999Z', '2026-08-11', '2026-08-12T00:00:00.000Z'],
    ['2026-08-12T00:00:00.000Z', '2026-08-12', '2026-08-13T00:00:00.000Z'],
  ])(
    'uses the captured UTC instant %s for the usage day and reset',
    (receivedAt, usageDate, resetAt) => {
      expect(quotaTime(new Date(receivedAt))).toEqual({
        resetAt: new Date(resetAt),
        usageDate,
      });
    },
  );

  it('rejects an invalid captured instant', () => {
    expect(() => quotaTime(new Date(Number.NaN))).toThrow(RangeError);
  });
});

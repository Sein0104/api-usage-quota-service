import { presentDailyUsage } from './daily-usage.presenter.js';

const row = {
  limitUnits: 1000n,
  updatedAt: new Date('2026-08-11T15:15:10.456Z'),
  usageDate: new Date('2026-08-11T00:00:00.000Z'),
  usedUnits: 20n,
};

describe('presentDailyUsage', () => {
  it('returns the exact JSON contract and derives remaining units', () => {
    expect(presentDailyUsage([row])).toEqual({
      items: [
        {
          limitUnits: 1000,
          remainingUnits: 980,
          updatedAt: '2026-08-11T15:15:10.456Z',
          usageDate: '2026-08-11',
          usedUnits: 20,
        },
      ],
    });
  });

  it.each([
    { ...row, limitUnits: 0n },
    { ...row, limitUnits: 1_000_000_001n },
    { ...row, usedUnits: -1n },
    { ...row, usedUnits: 1001n },
    { ...row, usageDate: new Date('2026-08-11T01:00:00.000Z') },
    { ...row, updatedAt: new Date(Number.NaN) },
  ])(
    'rejects an invalid stored row instead of serializing it: %p',
    (invalid) => {
      expect(() => presentDailyUsage([invalid])).toThrow();
    },
  );
});

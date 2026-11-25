import type { UsageTerminalResult } from './domain/usage-terminal-result.js';
import { presentUsageTerminal } from './usage.presenter.js';

function terminal(
  overrides: Partial<UsageTerminalResult> = {},
): UsageTerminalResult {
  return {
    decision: 'ACCEPTED',
    eventId: '4919714e-564c-48e1-bc0a-c92f3c9a96f6',
    quota: {
      limit: 1_000n,
      remaining: 997n,
      resetAt: new Date('2026-08-12T00:00:00.000Z'),
    },
    responseStatus: 200,
    units: 3n,
    usageDate: '2026-08-11',
    ...overrides,
  };
}

describe('presentUsageTerminal', () => {
  it('presents the exact JSON body and matching quota headers', () => {
    expect(presentUsageTerminal(terminal())).toEqual({
      body: {
        decision: 'ACCEPTED',
        eventId: '4919714e-564c-48e1-bc0a-c92f3c9a96f6',
        quota: {
          limit: 1_000,
          remaining: 997,
          resetAt: '2026-08-12T00:00:00.000Z',
        },
        units: 3,
        usageDate: '2026-08-11',
      },
      headers: {
        'X-Quota-Limit': '1000',
        'X-Quota-Remaining': '997',
        'X-Quota-Reset': '1786492800',
      },
    });
  });

  it('presents the maximum public quota and units without precision loss', () => {
    expect(
      presentUsageTerminal(
        terminal({
          quota: {
            limit: 1_000_000_000n,
            remaining: 999_990_000n,
            resetAt: new Date('2026-08-12T00:00:00.000Z'),
          },
          units: 10_000n,
        }),
      ).body,
    ).toMatchObject({
      quota: { limit: 1_000_000_000, remaining: 999_990_000 },
      units: 10_000,
    });
  });

  it.each([
    { units: 0n },
    { units: 10_001n },
    { quota: { limit: 1_000_000_001n, remaining: 0n, resetAt: new Date() } },
    { quota: { limit: 100n, remaining: 101n, resetAt: new Date() } },
  ])('rejects a terminal value outside the public numeric range: %o', (bad) => {
    expect(() => presentUsageTerminal(terminal(bad))).toThrow(RangeError);
  });
});

import type { UsageTerminalResult } from './domain/usage-terminal-result.js';
import type { PresentedUsageTerminal } from './quota-response.js';

function presentInteger(
  value: bigint,
  minimum: bigint,
  maximum: bigint,
): number {
  if (value < minimum || value > maximum) {
    throw new RangeError('A usage terminal value is outside its JSON range.');
  }
  return Number(value);
}

export function presentUsageTerminal(
  terminal: UsageTerminalResult,
): PresentedUsageTerminal {
  const limit = presentInteger(terminal.quota.limit, 1n, 1_000_000_000n);
  const remaining = presentInteger(
    terminal.quota.remaining,
    0n,
    terminal.quota.limit,
  );
  const units = presentInteger(terminal.units, 1n, 10_000n);
  return {
    body: {
      decision: terminal.decision,
      eventId: terminal.eventId,
      quota: {
        limit,
        remaining,
        resetAt: terminal.quota.resetAt.toISOString(),
      },
      units,
      usageDate: terminal.usageDate,
    },
    headers: {
      'X-Quota-Limit': String(limit),
      'X-Quota-Remaining': String(remaining),
      'X-Quota-Reset': String(
        Math.floor(terminal.quota.resetAt.getTime() / 1_000),
      ),
    },
  };
}

export type UsageTerminalDecision = 'ACCEPTED' | 'QUOTA_EXCEEDED';

export interface UsageTerminalResult {
  decision: UsageTerminalDecision;
  eventId: string;
  quota: {
    limit: bigint;
    remaining: bigint;
    resetAt: Date;
  };
  responseStatus: 200 | 429;
  units: bigint;
  usageDate: string;
}

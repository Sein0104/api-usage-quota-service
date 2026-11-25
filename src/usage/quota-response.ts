export interface QuotaResponse {
  limit: number;
  remaining: number;
  resetAt: string;
}

export interface UsageResponse {
  eventId: string;
  decision: 'ACCEPTED' | 'QUOTA_EXCEEDED';
  usageDate: string;
  units: number;
  quota: QuotaResponse;
}

export interface PresentedUsageTerminal {
  body: UsageResponse;
  headers: Record<string, string>;
}

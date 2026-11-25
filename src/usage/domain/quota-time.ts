export interface QuotaTime {
  resetAt: Date;
  usageDate: string;
}

export function quotaTime(receivedAt: Date): QuotaTime {
  if (!Number.isFinite(receivedAt.getTime())) {
    throw new RangeError('The captured request time must be valid.');
  }
  const usageDate = receivedAt.toISOString().slice(0, 10);
  const resetAt = new Date(`${usageDate}T00:00:00.000Z`);
  resetAt.setUTCDate(resetAt.getUTCDate() + 1);
  return { resetAt, usageDate };
}

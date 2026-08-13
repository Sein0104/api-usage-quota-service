export interface DailyUsageRecord {
  limitUnits: bigint;
  updatedAt: Date;
  usageDate: Date;
  usedUnits: bigint;
}

export interface DailyUsageItem {
  limitUnits: number;
  remainingUnits: number;
  updatedAt: string;
  usageDate: string;
  usedUnits: number;
}

function integer(value: bigint, minimum: bigint, maximum: bigint): number {
  if (value < minimum || value > maximum) {
    throw new RangeError('A daily usage value is outside its JSON range.');
  }
  return Number(value);
}

function iso(date: Date): string {
  if (Number.isNaN(date.getTime()))
    throw new RangeError('Invalid stored date.');
  return date.toISOString();
}

export function presentDailyUsage(records: readonly DailyUsageRecord[]): {
  items: DailyUsageItem[];
} {
  return {
    items: records.map((record) => {
      const limitUnits = integer(record.limitUnits, 1n, 1_000_000_000n);
      const usedUnits = integer(record.usedUnits, 0n, record.limitUnits);
      const usageDate = iso(record.usageDate);
      if (!usageDate.endsWith('T00:00:00.000Z')) {
        throw new RangeError('Stored usage date is not a UTC date.');
      }
      return {
        limitUnits,
        remainingUnits: limitUnits - usedUnits,
        updatedAt: iso(record.updatedAt),
        usageDate: usageDate.slice(0, 10),
        usedUnits,
      };
    }),
  };
}

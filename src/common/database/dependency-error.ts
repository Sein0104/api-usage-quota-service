const directCodes = new Set(['P1001', 'P1002', 'P1008', 'P1017', 'P2037']);
const connectionCodes = new Set([
  '08000',
  '08003',
  '08006',
  '53300',
  '57P01',
  '57P02',
  '57P03',
]);

export function isDatabaseDependencyError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null || !('code' in error))
    return false;
  const code = String(error.code);
  if (directCodes.has(code) || connectionCodes.has(code)) return true;
  if (code !== 'P2010' && code !== 'P2039') return false;
  const originalCode = (
    error as {
      meta?: { driverAdapterError?: { cause?: { originalCode?: unknown } } };
    }
  ).meta?.driverAdapterError?.cause?.originalCode;
  return typeof originalCode === 'string' && connectionCodes.has(originalCode);
}

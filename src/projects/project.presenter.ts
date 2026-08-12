import type { Project } from '../generated/prisma/client.js';

function presentBigInt(value: bigint): number {
  if (
    value > BigInt(Number.MAX_SAFE_INTEGER) ||
    value < BigInt(Number.MIN_SAFE_INTEGER)
  ) {
    throw new RangeError('A database integer exceeded the JSON safe range.');
  }
  return Number(value);
}

export function presentProject(project: Project): {
  id: string;
  name: string;
  dailyQuotaUnits: number;
  createdAt: string;
} {
  return {
    id: project.id,
    name: project.name,
    dailyQuotaUnits: presentBigInt(project.dailyQuotaUnits),
    createdAt: project.createdAt.toISOString(),
  };
}

import type { Project } from '../generated/prisma/client.js';

function presentBigInt(value: bigint): number {
  if (value > 1_000_000_000n || value < 0n) {
    throw new RangeError('A database quota exceeded the JSON response range.');
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

import type { Project } from '../generated/prisma/client.js';
import { presentProject } from './project.presenter.js';

function projectWithQuota(dailyQuotaUnits: bigint): Project {
  return {
    apiKeys: [],
    auditLogs: [],
    createdAt: new Date('2026-08-12T00:00:00.000Z'),
    dailyQuotaUnits,
    dailyUsage: [],
    id: '11111111-2222-4333-8444-555555555555',
    name: 'project',
    usageEvents: [],
  } as Project;
}

describe('presentProject', () => {
  it.each([0n, 1_000_000_000n])(
    'presents a quota within the schema response range: %s',
    (dailyQuotaUnits) => {
      expect(presentProject(projectWithQuota(dailyQuotaUnits))).toMatchObject({
        dailyQuotaUnits: Number(dailyQuotaUnits),
      });
    },
  );

  it.each([-1n, 1_000_000_001n])(
    'rejects a quota outside the schema response range: %s',
    (dailyQuotaUnits) => {
      expect(() => presentProject(projectWithQuota(dailyQuotaUnits))).toThrow(
        RangeError,
      );
    },
  );
});

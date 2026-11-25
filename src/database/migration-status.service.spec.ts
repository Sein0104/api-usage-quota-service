import { MigrationStatusService } from './migration-status.service.js';

function statusFor(error: unknown): MigrationStatusService {
  return new MigrationStatusService({
    query: async () => Promise.reject(error),
  } as never);
}

describe('MigrationStatusService', () => {
  it.each([
    [{ code: '42P01' }],
    [{ code: '08006' }],
    [{ code: 'ECONNREFUSED' }],
    [{ code: 'ENOTFOUND' }],
    [{ code: 'ETIMEDOUT' }],
    [{ code: '57P03' }],
  ])(
    'returns not ready for an unavailable migration dependency: %o',
    async (error) => {
      await expect(statusFor(error).isReady()).resolves.toBe(false);
    },
  );

  it.each([[{ code: '42501' }], [{ code: '42601' }]])(
    'rethrows an unexpected migration query error: %o',
    async (error) => {
      await expect(statusFor(error).isReady()).rejects.toBe(error);
    },
  );

  it('rethrows an error without an unavailable database code', async () => {
    const error = new Error('unexpected query programming failure');
    await expect(statusFor(error).isReady()).rejects.toBe(error);
  });
});

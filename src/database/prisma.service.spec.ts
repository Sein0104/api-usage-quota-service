import { PrismaService } from './prisma.service.js';

describe('PrismaService lifecycle', () => {
  it('disconnects Prisma before ending the shared pool once', async () => {
    const calls: string[] = [];
    const service = {
      $disconnect: async () => calls.push('disconnect'),
      pool: { end: async () => calls.push('pool.end') },
    };

    await PrismaService.prototype.onApplicationShutdown.call(service);

    expect(calls).toEqual(['disconnect', 'pool.end']);
  });
});

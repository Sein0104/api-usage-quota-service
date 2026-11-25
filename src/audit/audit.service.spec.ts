import { jest } from '@jest/globals';
import type { AuthenticatedApiKey } from '../api-keys/auth/authenticated-api-key.js';
import { AuditService } from './audit.service.js';
import { CursorCodec } from '../common/pagination/cursor-codec.js';

const actor: AuthenticatedApiKey = Object.freeze({
  id: '11111111-2222-4333-8444-555555555555',
  projectId: '22222222-2222-4333-8444-555555555555',
  scopes: ['audit:read'] as const,
});

describe('AuditService', () => {
  it('queries only the authenticated project and returns a strict cursor page', async () => {
    const rows = [
      {
        action: 'API_KEY_REVOKED',
        actorKeyId: actor.id,
        createdAt: new Date('2026-08-12T02:00:00.000Z'),
        id: '33333333-2222-4333-8444-555555555555',
        metadata: {
          name: 'worker',
          prefix: 'mq_44444444-2222-4333-8444-555555555555',
        },
        projectId: actor.projectId,
        requestId: '55555555-2222-4333-8444-555555555555',
        resourceApiKeyId: '44444444-2222-4333-8444-555555555555',
      },
    ];
    const list = jest.fn<() => Promise<typeof rows>>().mockResolvedValue(rows);
    const service = new AuditService({} as never, { list } as never);

    const result = await service.list(actor, { cursor: null, limit: 50 });

    expect(list).toHaveBeenCalledWith(
      expect.anything(),
      actor.projectId,
      null,
      51,
    );
    expect(result.items).toHaveLength(1);
    expect(result.nextCursor).toBeNull();
  });

  it('maps only dependency failures to 503', async () => {
    const dependency = new AuditService(
      {} as never,
      {
        list: jest
          .fn<() => Promise<never>>()
          .mockRejectedValue({ code: '08006' }),
      } as never,
    );
    await expect(
      dependency.list(actor, { cursor: null, limit: 50 }),
    ).rejects.toMatchObject({
      problem: { code: 'DEPENDENCY_UNAVAILABLE', status: 503 },
    });

    const defect = { code: '42601' };
    const syntax = new AuditService(
      {} as never,
      {
        list: jest.fn<() => Promise<never>>().mockRejectedValue(defect),
      } as never,
    );
    await expect(syntax.list(actor, { cursor: null, limit: 50 })).rejects.toBe(
      defect,
    );
  });

  it('uses limit plus one as a sentinel and encodes the second visible row', async () => {
    const rows = [
      ['33333333-2222-4333-8444-555555555555', '2026-08-12T03:00:00.000Z'],
      ['33333333-2222-4333-8444-555555555554', '2026-08-12T02:00:00.000Z'],
      ['33333333-2222-4333-8444-555555555553', '2026-08-12T01:00:00.000Z'],
    ].map(([id, createdAt]) => ({
      action: 'API_KEY_REVOKED',
      actorKeyId: actor.id,
      createdAt: new Date(createdAt),
      id,
      metadata: {
        name: 'worker',
        prefix: 'mq_44444444-2222-4333-8444-555555555555',
      },
      projectId: actor.projectId,
      requestId: '55555555-2222-4333-8444-555555555555',
      resourceApiKeyId: '44444444-2222-4333-8444-555555555555',
    }));
    const list = jest.fn<() => Promise<typeof rows>>().mockResolvedValue(rows);
    const codec = new CursorCodec();
    const service = new AuditService({} as never, { list } as never, codec);

    const result = await service.list(actor, { cursor: null, limit: 2 });

    expect(list).toHaveBeenCalledWith(
      expect.anything(),
      actor.projectId,
      null,
      3,
    );
    expect(result.items.map((item) => item.id)).toEqual([
      rows[0]?.id,
      rows[1]?.id,
    ]);
    expect(codec.decode(result.nextCursor!)).toEqual({
      createdAt: rows[1]?.createdAt,
      id: rows[1]?.id,
    });
  });
});

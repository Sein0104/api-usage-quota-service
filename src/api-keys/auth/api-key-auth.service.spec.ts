import { Buffer } from 'node:buffer';
import { jest } from '@jest/globals';
import { ApiKeyAuthService } from './api-key-auth.service.js';
import { ProblemException } from '../../common/http/problem.exception.js';

const id = '11111111-2222-4333-8444-555555555555';
const secret = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const credential = `mq_${id}.${secret}`;

describe('ApiKeyAuthService', () => {
  function service(row: unknown, digest = Buffer.alloc(32)): ApiKeyAuthService {
    return new ApiKeyAuthService(
      {
        apiKey: {
          findFirst: jest.fn<() => Promise<unknown>>().mockResolvedValue(row),
        },
      } as never,
      { digest: jest.fn().mockReturnValue(digest) } as never,
    );
  }

  it('rejects a 43-character base64url secret with non-canonical padding bits before lookup', async () => {
    const nonCanonical = `mq_${id}.${secret.slice(0, -1)}B`;
    const prisma = { apiKey: { findFirst: jest.fn() } };
    const auth = new ApiKeyAuthService(
      prisma as never,
      {
        digest: jest.fn().mockReturnValue(Buffer.alloc(32)),
      } as never,
    );

    await expect(auth.authenticate(nonCanonical)).rejects.toMatchObject<
      Partial<ProblemException>
    >({ problem: expect.objectContaining({ code: 'INVALID_API_KEY' }) });
    expect(prisma.apiKey.findFirst).not.toHaveBeenCalled();
  });

  it('returns only a frozen minimal principal for an active matching key', async () => {
    const row = {
      id,
      projectId: '22222222-2222-4333-8444-555555555555',
      scopes: ['audit:read', 'usage:read'],
      secretDigest: Buffer.alloc(32),
    };
    const principal = await service(row).authenticate(credential);
    expect(principal).toEqual({
      id,
      projectId: '22222222-2222-4333-8444-555555555555',
      scopes: ['usage:read', 'audit:read'],
    });
    expect(Object.isFrozen(principal)).toBe(true);
    expect(Object.isFrozen(principal.scopes)).toBe(true);
  });

  it.each([
    `mq_A${id.slice(1)}.${secret}`,
    `mq_${id}.${secret}=`,
    `mq_${id}.${secret}.extra`,
    `mq_${id}. ${secret}`,
    `mq_${id}.${secret.slice(1)}`,
  ])(
    'rejects malformed credential shape before database lookup: %s',
    async (rawCredential) => {
      const prisma = { apiKey: { findFirst: jest.fn() } };
      const auth = new ApiKeyAuthService(
        prisma as never,
        { digest: jest.fn() } as never,
      );
      await expect(auth.authenticate(rawCredential)).rejects.toMatchObject({
        problem: { code: 'INVALID_API_KEY' },
      });
      expect(prisma.apiKey.findFirst).not.toHaveBeenCalled();
    },
  );

  it('rejects a wrong secret for an existing id with the same credential problem', async () => {
    const wrong = `mq_${id}.${'B'.repeat(43)}`;
    const auth = service({
      id,
      projectId: id,
      scopes: ['usage:read'],
      secretDigest: Buffer.alloc(32, 1),
    });
    await expect(auth.authenticate(wrong)).rejects.toMatchObject({
      problem: { code: 'INVALID_API_KEY' },
    });
  });

  it('calculates a candidate digest even when the key id is unknown', async () => {
    const digest = jest.fn().mockReturnValue(Buffer.alloc(32));
    const auth = new ApiKeyAuthService(
      {
        apiKey: {
          findFirst: jest.fn<() => Promise<unknown>>().mockResolvedValue(null),
        },
      } as never,
      { digest } as never,
    );

    await expect(auth.authenticate(credential)).rejects.toMatchObject({
      problem: expect.objectContaining({ code: 'INVALID_API_KEY' }),
    });
    expect(digest).toHaveBeenCalledWith(credential);
  });

  it('translates a nested Prisma connection error but not a nested syntax error', async () => {
    const connection = service(null);
    (
      connection as unknown as {
        prisma: { apiKey: { findFirst: jest.Mock<() => Promise<unknown>> } };
      }
    ).prisma.apiKey.findFirst.mockRejectedValueOnce({
      code: 'P2010',
      meta: { driverAdapterError: { cause: { originalCode: '08006' } } },
    });
    await expect(connection.authenticate(credential)).rejects.toMatchObject({
      problem: expect.objectContaining({ code: 'DEPENDENCY_UNAVAILABLE' }),
    });

    const syntax = service(null);
    (
      syntax as unknown as {
        prisma: { apiKey: { findFirst: jest.Mock<() => Promise<unknown>> } };
      }
    ).prisma.apiKey.findFirst.mockRejectedValueOnce({
      code: 'P2010',
      meta: { driverAdapterError: { cause: { originalCode: '42601' } } },
    });
    await expect(syntax.authenticate(credential)).rejects.toMatchObject({
      code: 'P2010',
    });
  });
});

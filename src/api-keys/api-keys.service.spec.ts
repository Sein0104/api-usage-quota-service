import { ApiKeysService } from './api-keys.service.js';
import { jest } from '@jest/globals';
import { ProblemException } from '../common/http/problem.exception.js';

const actor = {
  id: '11111111-2222-4333-8444-555555555555',
  projectId: '22222222-2222-4333-8444-555555555555',
  scopes: ['keys:manage'] as const,
};

describe('ApiKeysService.create', () => {
  it.each([
    { name: ' whitespace ', scopes: ['usage:read'] },
    { name: 'valid', scopes: [] },
    { name: 'valid', scopes: ['usage:read', 'usage:read'] },
    { name: 'valid', scopes: ['unknown'] },
    { name: 'valid', scopes: 'usage:read' },
  ])(
    'rejects invalid direct runtime input before starting a transaction: %o',
    async (command) => {
      const transaction = jest.fn();
      const service = new ApiKeysService(
        { $transaction: transaction } as never,
        { issue: jest.fn() } as never,
        {} as never,
        {} as never,
      );

      await expect(
        service.create(actor, command as never, {
          requestId: '33333333-2222-4333-8444-555555555555',
        }),
      ).rejects.toMatchObject<Partial<ProblemException>>({
        problem: expect.objectContaining({
          code: 'VALIDATION_ERROR',
          status: 400,
        }),
      });
      expect(transaction).not.toHaveBeenCalled();
    },
  );
});

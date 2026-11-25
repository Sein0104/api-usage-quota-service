import { parseRevokeApiKeyId } from './revoke-api-key.params.js';

describe('parseRevokeApiKeyId', () => {
  it('accepts a canonical lowercase UUID', () => {
    expect(parseRevokeApiKeyId('11111111-2222-4333-8444-555555555555')).toBe(
      '11111111-2222-4333-8444-555555555555',
    );
  });

  it.each([
    '',
    'not-a-uuid',
    '11111111-2222-4333-8444-55555555555A',
    ' 11111111-2222-4333-8444-555555555555',
  ])('rejects invalid or non-canonical id %s', (id) => {
    expect(() => parseRevokeApiKeyId(id)).toThrow(
      expect.objectContaining({
        problem: expect.objectContaining({
          code: 'VALIDATION_ERROR',
          status: 400,
        }),
      }),
    );
  });
});

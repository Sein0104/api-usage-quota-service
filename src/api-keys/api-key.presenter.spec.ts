import { presentApiKey } from './api-key.presenter.js';

describe('presentApiKey', () => {
  it('returns only canonical public metadata from a safe record', () => {
    expect(
      presentApiKey({
        createdAt: new Date('2026-08-12T12:34:56.789Z'),
        id: '11111111-2222-4333-8444-555555555555',
        name: 'reader',
        prefix: 'mq_11111111-2222-4333-8444-555555555555',
        revokedAt: null,
        scopes: ['audit:read', 'usage:read'],
        status: 'ACTIVE',
      }),
    ).toEqual({
      id: '11111111-2222-4333-8444-555555555555',
      name: 'reader',
      prefix: 'mq_11111111-2222-4333-8444-555555555555',
      scopes: ['usage:read', 'audit:read'],
      status: 'ACTIVE',
      createdAt: '2026-08-12T12:34:56.789Z',
      revokedAt: null,
    });
  });
});

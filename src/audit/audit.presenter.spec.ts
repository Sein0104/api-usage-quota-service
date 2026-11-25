import { presentAuditLog, type AuditLogRecord } from './audit.presenter.js';

const base: AuditLogRecord = {
  action: 'API_KEY_CREATED',
  actorKeyId: '11111111-2222-4333-8444-555555555555',
  createdAt: new Date('2026-08-12T01:02:03.004Z'),
  id: '22222222-2222-4333-8444-555555555555',
  metadata: {
    name: 'worker',
    prefix: 'mq_33333333-2222-4333-8444-555555555555',
    scopes: ['usage:write'],
  },
  projectId: '44444444-2222-4333-8444-555555555555',
  requestId: '55555555-2222-4333-8444-555555555555',
  resourceApiKeyId: '33333333-2222-4333-8444-555555555555',
};

describe('presentAuditLog', () => {
  it('derives the API-key resource and returns only action-specific metadata', () => {
    expect(
      presentAuditLog({
        ...base,
        metadata: {
          ...(base.metadata as Record<string, unknown>),
          authorization: 'Bearer leaked',
          secretDigest: 'leaked',
        },
      }),
    ).toEqual({
      action: 'API_KEY_CREATED',
      actorKeyId: '11111111-2222-4333-8444-555555555555',
      createdAt: '2026-08-12T01:02:03.004Z',
      id: '22222222-2222-4333-8444-555555555555',
      metadata: {
        name: 'worker',
        prefix: 'mq_33333333-2222-4333-8444-555555555555',
        scopes: ['usage:write'],
      },
      requestId: '55555555-2222-4333-8444-555555555555',
      resourceId: '33333333-2222-4333-8444-555555555555',
      resourceType: 'API_KEY',
    });
  });

  it('derives the project resource without exposing projectId as an extra field', () => {
    expect(
      presentAuditLog({
        ...base,
        action: 'PROJECT_CREATED',
        actorKeyId: null,
        metadata: {
          dailyQuotaUnits: 1000,
          initialApiKeyId: '33333333-2222-4333-8444-555555555555',
          projectName: 'demo',
        },
        resourceApiKeyId: null,
      }),
    ).toEqual(
      expect.objectContaining({
        actorKeyId: null,
        resourceId: '44444444-2222-4333-8444-555555555555',
        resourceType: 'PROJECT',
      }),
    );
  });

  it('uses Unicode code points for the database-compatible name limit', () => {
    expect(
      presentAuditLog({
        ...base,
        action: 'PROJECT_CREATED',
        actorKeyId: null,
        metadata: {
          dailyQuotaUnits: 1000,
          initialApiKeyId: '33333333-2222-4333-8444-555555555555',
          projectName: '😀'.repeat(60),
        },
        resourceApiKeyId: null,
      }).metadata,
    ).toMatchObject({ projectName: '😀'.repeat(60) });
  });

  it.each([
    { ...base, metadata: { name: 'worker' } },
    { ...base, action: 'API_KEY_REVOKED', resourceApiKeyId: null },
    { ...base, action: 'PROJECT_CREATED', actorKeyId: base.actorKeyId },
    {
      ...base,
      metadata: {
        ...(base.metadata as Record<string, unknown>),
        prefix: 'mq_99999999-2222-4333-8444-555555555555',
      },
    },
    { ...base, action: 'FUTURE_ACTION' as never },
  ] as AuditLogRecord[])('fails closed for an invalid stored row', (record) => {
    expect(() => presentAuditLog(record)).toThrow();
  });
});

import {
  canonicalizeApiScopes,
  isApiScope,
} from '../api-keys/api-key.scopes.js';

export type PublicAuditAction =
  'PROJECT_CREATED' | 'API_KEY_CREATED' | 'API_KEY_REVOKED';

export interface AuditLogRecord {
  action: PublicAuditAction;
  actorKeyId: string | null;
  createdAt: Date;
  id: string;
  metadata: unknown;
  projectId: string;
  requestId: string;
  resourceApiKeyId: string | null;
}

export type PresentedAuditLog = ReturnType<typeof presentAuditLog>;

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const prefix =
  /^mq_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function object(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Stored audit metadata invariant violated.');
  }
  return value as Record<string, unknown>;
}

function string(metadata: Record<string, unknown>, key: string): string {
  const value = metadata[key];
  if (
    typeof value !== 'string' ||
    Array.from(value).length < 1 ||
    Array.from(value).length > 100 ||
    value.trim() !== value
  ) {
    throw new Error('Stored audit metadata invariant violated.');
  }
  return value;
}

function keyPrefix(
  metadata: Record<string, unknown>,
  resourceApiKeyId: string,
): string {
  const value = string(metadata, 'prefix');
  if (!prefix.test(value) || value !== `mq_${resourceApiKeyId}`) {
    throw new Error('Stored audit metadata invariant violated.');
  }
  return value;
}

function apiKeyId(metadata: Record<string, unknown>, key: string): string {
  const value = metadata[key];
  if (typeof value !== 'string' || !uuid.test(value)) {
    throw new Error('Stored audit metadata invariant violated.');
  }
  return value;
}

function iso(value: Date): string {
  if (Number.isNaN(value.getTime()))
    throw new Error('Stored audit timestamp invariant violated.');
  return value.toISOString();
}

export function presentAuditLog(record: AuditLogRecord) {
  if (
    ![record.id, record.projectId, record.requestId].every((value) =>
      uuid.test(value),
    )
  ) {
    throw new Error('Stored audit identifier invariant violated.');
  }
  const metadata = object(record.metadata);
  const common = {
    action: record.action,
    actorKeyId: record.actorKeyId,
    createdAt: iso(record.createdAt),
    id: record.id,
    requestId: record.requestId,
  };

  if (record.action === 'PROJECT_CREATED') {
    const dailyQuotaUnits = metadata.dailyQuotaUnits;
    if (
      record.actorKeyId !== null ||
      record.resourceApiKeyId !== null ||
      !Number.isInteger(dailyQuotaUnits) ||
      Number(dailyQuotaUnits) < 1 ||
      Number(dailyQuotaUnits) > 1_000_000_000
    ) {
      throw new Error('Stored project audit invariant violated.');
    }
    return {
      ...common,
      metadata: {
        dailyQuotaUnits: Number(dailyQuotaUnits),
        initialApiKeyId: apiKeyId(metadata, 'initialApiKeyId'),
        projectName: string(metadata, 'projectName'),
      },
      resourceId: record.projectId,
      resourceType: 'PROJECT' as const,
    };
  }

  if (
    (record.action !== 'API_KEY_CREATED' &&
      record.action !== 'API_KEY_REVOKED') ||
    record.actorKeyId === null ||
    !uuid.test(record.actorKeyId) ||
    record.resourceApiKeyId === null ||
    !uuid.test(record.resourceApiKeyId)
  ) {
    throw new Error('Stored API key audit invariant violated.');
  }
  const presentedMetadata: Record<string, unknown> = {
    name: string(metadata, 'name'),
    prefix: keyPrefix(metadata, record.resourceApiKeyId),
  };
  if (record.action === 'API_KEY_CREATED') {
    const scopes = metadata.scopes;
    if (
      !Array.isArray(scopes) ||
      scopes.length < 1 ||
      scopes.length > 4 ||
      new Set(scopes).size !== scopes.length ||
      scopes.some((scope) => typeof scope !== 'string' || !isApiScope(scope))
    ) {
      throw new Error('Stored API key audit scope invariant violated.');
    }
    presentedMetadata.scopes = canonicalizeApiScopes(scopes as string[]);
  }
  return {
    ...common,
    metadata: presentedMetadata,
    resourceId: record.resourceApiKeyId,
    resourceType: 'API_KEY' as const,
  };
}

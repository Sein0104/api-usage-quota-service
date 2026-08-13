import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class ProjectModel {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ maxLength: 100, minLength: 1 }) name!: string;
  @ApiProperty({ maximum: 1_000_000_000, minimum: 1, type: 'integer' })
  dailyQuotaUnits!: number;
  @ApiProperty({ format: 'date-time' }) createdAt!: string;
}

export class ApiKeyMetadataModel {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ maxLength: 100, minLength: 1 }) name!: string;
  @ApiProperty({
    pattern:
      '^mq_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$',
  })
  prefix!: string;
  @ApiProperty({
    enum: ['usage:write', 'usage:read', 'keys:manage', 'audit:read'],
    isArray: true,
    maxItems: 4,
    minItems: 1,
    uniqueItems: true,
  })
  scopes!: string[];
  @ApiProperty({ enum: ['ACTIVE', 'REVOKED'] }) status!: string;
  @ApiProperty({ format: 'date-time' }) createdAt!: string;
  @ApiProperty({ format: 'date-time', nullable: true, type: String })
  revokedAt!: string | null;
}

export class ActiveApiKeyMetadataModel {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ maxLength: 100, minLength: 1 }) name!: string;
  @ApiProperty({
    pattern:
      '^mq_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$',
  })
  prefix!: string;
  @ApiProperty({
    enum: ['usage:write', 'usage:read', 'keys:manage', 'audit:read'],
    isArray: true,
    maxItems: 4,
    minItems: 1,
    uniqueItems: true,
  })
  scopes!: string[];
  @ApiProperty({ enum: ['ACTIVE'] }) status!: 'ACTIVE';
  @ApiProperty({ format: 'date-time' }) createdAt!: string;
  @ApiProperty({ enum: [null], nullable: true, type: String })
  revokedAt!: null;
}

export class ProjectBootstrapResponseModel {
  @ApiProperty({ type: ProjectModel }) project!: ProjectModel;
  @ApiProperty({ type: ActiveApiKeyMetadataModel })
  apiKey!: ActiveApiKeyMetadataModel;
  @ApiProperty({
    format: 'password',
    pattern:
      '^mq_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\\.[A-Za-z0-9_-]{43}$',
    readOnly: true,
  })
  secret!: string;
}

export class ApiKeyCreateResponseModel {
  @ApiProperty({ type: ActiveApiKeyMetadataModel })
  apiKey!: ActiveApiKeyMetadataModel;
  @ApiProperty({
    format: 'password',
    pattern:
      '^mq_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\\.[A-Za-z0-9_-]{43}$',
    readOnly: true,
  })
  secret!: string;
}

export class ApiKeyPageModel {
  @ApiProperty({ isArray: true, type: ApiKeyMetadataModel })
  items!: ApiKeyMetadataModel[];
  @ApiProperty({ nullable: true, type: String }) nextCursor!: string | null;
}

export class QuotaSnapshotModel {
  @ApiProperty({ maximum: 1_000_000_000, minimum: 1, type: 'integer' })
  limit!: number;
  @ApiProperty({ maximum: 1_000_000_000, minimum: 0, type: 'integer' })
  remaining!: number;
  @ApiProperty({ format: 'date-time' }) resetAt!: string;
}

export class AcceptedUsageResponseModel {
  @ApiProperty({ format: 'uuid' }) eventId!: string;
  @ApiProperty({ enum: ['ACCEPTED'] }) decision!: 'ACCEPTED';
  @ApiProperty({ format: 'date' }) usageDate!: string;
  @ApiProperty({ maximum: 10_000, minimum: 1, type: 'integer' }) units!: number;
  @ApiProperty({ type: QuotaSnapshotModel }) quota!: QuotaSnapshotModel;
}

export class DailyUsageItemModel {
  @ApiProperty({ format: 'date' }) usageDate!: string;
  @ApiProperty({ minimum: 0, type: 'integer' }) usedUnits!: number;
  @ApiProperty({ minimum: 1, type: 'integer' }) limitUnits!: number;
  @ApiProperty({ minimum: 0, type: 'integer' }) remainingUnits!: number;
  @ApiProperty({ format: 'date-time' }) updatedAt!: string;
}

export class DailyUsageResponseModel {
  @ApiProperty({ isArray: true, type: DailyUsageItemModel })
  items!: DailyUsageItemModel[];
}

export class ProjectCreatedMetadataModel {
  @ApiProperty({ maxLength: 100, minLength: 1 }) projectName!: string;
  @ApiProperty({ maximum: 1_000_000_000, minimum: 1, type: 'integer' })
  dailyQuotaUnits!: number;
  @ApiProperty({ format: 'uuid' }) initialApiKeyId!: string;
}

export class ApiKeyCreatedMetadataModel {
  @ApiProperty({ maxLength: 100, minLength: 1 }) name!: string;
  @ApiProperty({
    pattern:
      '^mq_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$',
  })
  prefix!: string;
  @ApiProperty({
    enum: ['usage:write', 'usage:read', 'keys:manage', 'audit:read'],
    isArray: true,
    maxItems: 4,
    minItems: 1,
    uniqueItems: true,
  })
  scopes!: string[];
}

export class ApiKeyRevokedMetadataModel {
  @ApiProperty({ maxLength: 100, minLength: 1 }) name!: string;
  @ApiProperty({
    pattern:
      '^mq_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$',
  })
  prefix!: string;
}

export class AuditLogModel {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({
    enum: ['PROJECT_CREATED', 'API_KEY_CREATED', 'API_KEY_REVOKED'],
  })
  action!: string;
  @ApiProperty({ enum: ['PROJECT', 'API_KEY'] }) resourceType!: string;
  @ApiProperty({ format: 'uuid' }) resourceId!: string;
  @ApiProperty({ format: 'uuid', nullable: true, type: String })
  actorKeyId!: string | null;
  @ApiProperty({ format: 'uuid' }) requestId!: string;
  @ApiProperty({
    oneOf: [
      { $ref: '#/components/schemas/ProjectCreatedMetadataModel' },
      { $ref: '#/components/schemas/ApiKeyCreatedMetadataModel' },
      { $ref: '#/components/schemas/ApiKeyRevokedMetadataModel' },
    ],
  })
  metadata!:
    | ProjectCreatedMetadataModel
    | ApiKeyCreatedMetadataModel
    | ApiKeyRevokedMetadataModel;
  @ApiProperty({ format: 'date-time' }) createdAt!: string;
}

export class AuditLogPageModel {
  @ApiProperty({ isArray: true, type: AuditLogModel }) items!: AuditLogModel[];
  @ApiProperty({ nullable: true, type: String }) nextCursor!: string | null;
}

export class LiveHealth {
  @ApiProperty({ enum: ['ok'] }) status!: 'ok';
}

export class ReadyHealth {
  @ApiProperty({ enum: ['ready'] }) status!: 'ready';
}

export class NotReadyHealth {
  @ApiProperty({ enum: ['not_ready'] }) status!: 'not_ready';
}

export class ProblemModel {
  @ApiProperty({ format: 'uri' }) type!: string;
  @ApiProperty() title!: string;
  @ApiProperty({ type: 'integer' }) status!: number;
  @ApiProperty() detail!: string;
  @ApiProperty() code!: string;
  @ApiProperty({ format: 'uuid' }) requestId!: string;
  @ApiPropertyOptional({ isArray: true, type: Object }) errors?: object[];
}

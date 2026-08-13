import { Controller, Get, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { ApiKeyAuthGuard } from '../api-keys/auth/api-key-auth.guard.js';
import type { AuthenticatedApiKey } from '../api-keys/auth/authenticated-api-key.js';
import { CurrentApiKey } from '../api-keys/auth/current-api-key.decorator.js';
import { RequiredScopes } from '../api-keys/auth/required-scopes.decorator.js';
import { ScopesGuard } from '../api-keys/auth/scopes.guard.js';
import { CursorCodec } from '../common/pagination/cursor-codec.js';
import { AuditService } from './audit.service.js';
import { parseListAuditLogsQuery } from './dto/list-audit-logs.query.js';
import {
  ApiExtraModels,
  ApiOkResponse,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import {
  ApiProblemResponses,
  ApiProjectSecurity,
} from '../openapi.decorators.js';
import {
  ApiKeyCreatedMetadataModel,
  ApiKeyRevokedMetadataModel,
  AuditLogPageModel,
  ProjectCreatedMetadataModel,
} from '../openapi.models.js';

@Controller('audit-logs')
@UseGuards(ApiKeyAuthGuard, ScopesGuard)
@ApiTags('audit')
@ApiProjectSecurity()
@ApiExtraModels(
  ProjectCreatedMetadataModel,
  ApiKeyCreatedMetadataModel,
  ApiKeyRevokedMetadataModel,
)
export class AuditController {
  constructor(
    private readonly audit: AuditService,
    private readonly cursorCodec: CursorCodec,
  ) {}

  @Get()
  @RequiredScopes('audit:read')
  @ApiQuery({
    description: 'Opaque unpadded base64url pagination cursor.',
    name: 'cursor',
    required: false,
    schema: {
      minLength: 1,
      pattern: '^[A-Za-z0-9_-]+$',
      type: 'string',
    },
  })
  @ApiQuery({
    maximum: 100,
    minimum: 1,
    schema: { default: 50, maximum: 100, minimum: 1, type: 'integer' },
    name: 'limit',
    required: false,
  })
  @ApiOkResponse({ type: AuditLogPageModel })
  @ApiProblemResponses(400, 401, 403, 500, 503)
  list(@CurrentApiKey() actor: AuthenticatedApiKey, @Req() request: Request) {
    return this.audit.list(
      actor,
      parseListAuditLogsQuery(request.query, this.cursorCodec),
    );
  }
}

import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { JsonContentTypeGuard } from '../common/http/json-content-type.guard.js';
import { CurrentApiKey } from './auth/current-api-key.decorator.js';
import type { AuthenticatedApiKey } from './auth/authenticated-api-key.js';
import { ApiKeyAuthGuard } from './auth/api-key-auth.guard.js';
import { RequiredScopes } from './auth/required-scopes.decorator.js';
import { ScopesGuard } from './auth/scopes.guard.js';
import { CreateApiKeyDto } from './dto/create-api-key.dto.js';
import { presentApiKey } from './api-key.presenter.js';
import { ApiKeysService } from './api-keys.service.js';
import type { Request } from 'express';
import { CursorCodec } from '../common/pagination/cursor-codec.js';
import { parseListApiKeysQuery } from './dto/list-api-keys.query.js';
import { parseRevokeApiKeyId } from './dto/revoke-api-key.params.js';
import {
  ApiCreatedResponse,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiParam,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import {
  ApiProblemResponses,
  ApiProjectSecurity,
} from '../openapi.decorators.js';
import {
  ApiKeyCreateResponseModel,
  ApiKeyPageModel,
} from '../openapi.models.js';

@Controller('api-keys')
@UseGuards(ApiKeyAuthGuard, ScopesGuard, JsonContentTypeGuard)
@ApiTags('api-keys')
@ApiProjectSecurity()
export class ApiKeysController {
  constructor(
    private readonly apiKeys: ApiKeysService,
    private readonly cursorCodec: CursorCodec,
  ) {}

  @Post()
  @HttpCode(201)
  @RequiredScopes('keys:manage')
  @ApiCreatedResponse({ type: ApiKeyCreateResponseModel })
  @ApiProblemResponses(400, 401, 403, 409, 415, 500, 503)
  async create(
    @CurrentApiKey() actor: AuthenticatedApiKey,
    @Body() body: CreateApiKeyDto,
    @Req() request: Request,
  ): Promise<{ apiKey: ReturnType<typeof presentApiKey>; secret: string }> {
    const result = await this.apiKeys.create(
      actor,
      body,
      request.requestContext!,
    );
    return { apiKey: presentApiKey(result.apiKey), secret: result.plaintext };
  }

  @Get()
  @RequiredScopes('keys:manage')
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
  @ApiOkResponse({ type: ApiKeyPageModel })
  @ApiProblemResponses(400, 401, 403, 500, 503)
  async list(
    @CurrentApiKey() actor: AuthenticatedApiKey,
    @Req() request: Request,
  ) {
    return this.apiKeys.list(
      actor,
      parseListApiKeysQuery(request.query, this.cursorCodec),
    );
  }

  @Delete(':id')
  @HttpCode(204)
  @RequiredScopes('keys:manage')
  @ApiParam({
    name: 'id',
    required: true,
    schema: {
      format: 'uuid',
      pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$',
      type: 'string',
    },
  })
  @ApiNoContentResponse()
  @ApiProblemResponses(400, 401, 403, 404, 409, 500, 503)
  async revoke(
    @CurrentApiKey() actor: AuthenticatedApiKey,
    @Param('id') id: string,
    @Req() request: Request,
  ): Promise<void> {
    await this.apiKeys.revoke(actor, parseRevokeApiKeyId(id), {
      requestId: request.requestContext!.requestId,
    });
  }
}

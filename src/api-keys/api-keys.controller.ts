import { Body, Controller, HttpCode, Post, UseGuards } from '@nestjs/common';
import { JsonContentTypeGuard } from '../common/http/json-content-type.guard.js';
import { CurrentApiKey } from './auth/current-api-key.decorator.js';
import type { AuthenticatedApiKey } from './auth/authenticated-api-key.js';
import { ApiKeyAuthGuard } from './auth/api-key-auth.guard.js';
import { RequiredScopes } from './auth/required-scopes.decorator.js';
import { ScopesGuard } from './auth/scopes.guard.js';
import { CreateApiKeyDto } from './dto/create-api-key.dto.js';
import { presentApiKey } from './api-key.presenter.js';
import { ApiKeysService } from './api-keys.service.js';
import { Req } from '@nestjs/common';
import type { Request } from 'express';

@Controller('api-keys')
@UseGuards(ApiKeyAuthGuard, ScopesGuard, JsonContentTypeGuard)
export class ApiKeysController {
  constructor(private readonly apiKeys: ApiKeysService) {}

  @Post()
  @HttpCode(201)
  @RequiredScopes('keys:manage')
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
}

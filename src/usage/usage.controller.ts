import {
  Body,
  Controller,
  HttpCode,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { ApiKeyAuthGuard } from '../api-keys/auth/api-key-auth.guard.js';
import type { AuthenticatedApiKey } from '../api-keys/auth/authenticated-api-key.js';
import { CurrentApiKey } from '../api-keys/auth/current-api-key.decorator.js';
import { RequiredScopes } from '../api-keys/auth/required-scopes.decorator.js';
import { ScopesGuard } from '../api-keys/auth/scopes.guard.js';
import { JsonContentTypeGuard } from '../common/http/json-content-type.guard.js';
import { CreateUsageEventDto } from './dto/create-usage-event.dto.js';
import { QuotaExceededException } from './quota-exceeded.exception.js';
import type { UsageResponse } from './quota-response.js';
import { presentUsageTerminal } from './usage.presenter.js';
import { UsageService } from './usage.service.js';

@Controller('usage-events')
@UseGuards(ApiKeyAuthGuard, ScopesGuard, JsonContentTypeGuard)
export class UsageController {
  constructor(private readonly usage: UsageService) {}

  @Post()
  @HttpCode(200)
  @RequiredScopes('usage:write')
  async ingest(
    @CurrentApiKey() actor: AuthenticatedApiKey,
    @Body() body: CreateUsageEventDto,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<UsageResponse> {
    if (request.idempotencyKey === undefined) {
      throw new Error('Validated idempotency key invariant violated.');
    }
    const terminal = await this.usage.ingest(
      actor,
      body,
      request.idempotencyKey,
      request.requestContext!,
    );
    const presented = presentUsageTerminal(terminal);
    if (terminal.responseStatus === 429) {
      throw new QuotaExceededException(presented);
    }
    for (const [name, value] of Object.entries(presented.headers)) {
      response.setHeader(name, value);
    }
    return presented.body;
  }
}

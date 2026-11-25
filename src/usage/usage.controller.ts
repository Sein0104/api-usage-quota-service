import {
  Body,
  Controller,
  Get,
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
import { DailyUsageService } from './daily-usage.service.js';
import { parseListDailyUsageQuery } from './dto/list-daily-usage.query.js';
import {
  presentDailyUsage,
  type DailyUsageItem,
} from './daily-usage.presenter.js';
import { ApiHeader, ApiOkResponse, ApiQuery, ApiTags } from '@nestjs/swagger';
import {
  ApiProblemResponses,
  ApiProjectSecurity,
} from '../openapi.decorators.js';
import {
  AcceptedUsageResponseModel,
  DailyUsageResponseModel,
} from '../openapi.models.js';

@Controller('usage-events')
@UseGuards(ApiKeyAuthGuard, ScopesGuard, JsonContentTypeGuard)
@ApiTags('usage')
@ApiProjectSecurity()
export class UsageController {
  constructor(private readonly usage: UsageService) {}

  @Post()
  @HttpCode(200)
  @RequiredScopes('usage:write')
  @ApiHeader({
    name: 'Idempotency-Key',
    required: true,
    schema: {
      format: 'uuid',
      pattern:
        '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$',
      type: 'string',
    },
  })
  @ApiOkResponse({ type: AcceptedUsageResponseModel })
  @ApiProblemResponses(400, 401, 403, 409, 415, 429, 500, 503)
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

@Controller('usage')
@UseGuards(ApiKeyAuthGuard, ScopesGuard)
@ApiTags('usage')
@ApiProjectSecurity()
export class DailyUsageController {
  constructor(private readonly dailyUsage: DailyUsageService) {}

  @Get('daily')
  @RequiredScopes('usage:read')
  @ApiQuery({
    description:
      'Inclusive range start as one canonical UTC YYYY-MM-DD date. Duplicate and unknown query fields are rejected; the inclusive range may span at most 90 days.',
    format: 'date',
    name: 'from',
    required: true,
    type: String,
  })
  @ApiQuery({
    description:
      'Inclusive range end as one canonical UTC YYYY-MM-DD date. It must be on or after from; duplicate and unknown query fields are rejected; the inclusive range may span at most 90 days.',
    format: 'date',
    name: 'to',
    required: true,
    type: String,
  })
  @ApiOkResponse({ type: DailyUsageResponseModel })
  @ApiProblemResponses(400, 401, 403, 500, 503)
  async list(
    @CurrentApiKey() actor: AuthenticatedApiKey,
    @Req() request: Request,
  ): Promise<{ items: DailyUsageItem[] }> {
    const query = parseListDailyUsageQuery(
      request.query as Record<string, unknown>,
    );
    return presentDailyUsage(
      await this.dailyUsage.list(actor, query.from, query.to),
    );
  }
}

import { Controller, Get, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { MetricsService } from './metrics.service.js';
import { MetricsTokenGuard } from './metrics-token.guard.js';
import { ApiOkResponse, ApiProduces, ApiTags } from '@nestjs/swagger';
import {
  ApiMetricsSecurity,
  ApiProblemResponses,
} from '../openapi.decorators.js';

@Controller('metrics')
@UseGuards(MetricsTokenGuard)
@ApiTags('metrics')
@ApiMetricsSecurity()
export class MetricsController {
  constructor(private readonly metrics: MetricsService) {}

  @Get()
  @ApiProduces('text/plain')
  @ApiOkResponse({ schema: { type: 'string' } })
  @ApiProblemResponses(401, 500)
  async exposition(@Res() response: Response): Promise<void> {
    response.setHeader('Content-Type', this.metrics.contentType);
    response.end(await this.metrics.exposition());
  }
}

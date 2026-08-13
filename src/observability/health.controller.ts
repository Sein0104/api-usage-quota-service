import { Controller, Get, HttpStatus, Res } from '@nestjs/common';
import type { Response } from 'express';
import { MigrationStatusService } from '../database/migration-status.service.js';
import {
  ApiExtraModels,
  ApiOkResponse,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { LiveHealth, NotReadyHealth, ReadyHealth } from '../openapi.models.js';
import { ApiProblemResponses } from '../openapi.decorators.js';

@Controller('health')
@ApiTags('health')
@ApiExtraModels(NotReadyHealth)
export class HealthController {
  constructor(private readonly migrationStatus: MigrationStatusService) {}

  @Get('live')
  @ApiOkResponse({ type: LiveHealth })
  live(): { status: 'ok' } {
    return { status: 'ok' };
  }

  @Get('ready')
  @ApiOkResponse({ type: ReadyHealth })
  @ApiResponse({
    content: {
      'application/json': {
        schema: { $ref: '#/components/schemas/NotReadyHealth' },
      },
    },
    description: 'PostgreSQL or migrations are not ready.',
    status: 503,
  })
  @ApiProblemResponses(500)
  async ready(
    @Res({ passthrough: true }) response: Response,
  ): Promise<{ status: 'ready' | 'not_ready' }> {
    if (await this.migrationStatus.isReady()) {
      return { status: 'ready' };
    }

    response.status(HttpStatus.SERVICE_UNAVAILABLE);
    return { status: 'not_ready' };
  }
}

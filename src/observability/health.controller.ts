import { Controller, Get, HttpStatus, Res } from '@nestjs/common';
import type { Response } from 'express';
import { MigrationStatusService } from '../database/migration-status.service.js';

@Controller('health')
export class HealthController {
  constructor(private readonly migrationStatus: MigrationStatusService) {}

  @Get('live')
  live(): { status: 'ok' } {
    return { status: 'ok' };
  }

  @Get('ready')
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

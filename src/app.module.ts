import { Module } from '@nestjs/common';
import { HealthController } from './observability/health.controller.js';

@Module({
  controllers: [HealthController],
})
export class AppModule {}

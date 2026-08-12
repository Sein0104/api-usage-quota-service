import { Module } from '@nestjs/common';
import { DatabaseModule } from './database/database.module.js';
import { HealthController } from './observability/health.controller.js';

@Module({
  imports: [DatabaseModule],
  controllers: [HealthController],
})
export class AppModule {}

import { Module } from '@nestjs/common';
import { DatabaseModule } from './database/database.module.js';
import { HealthController } from './observability/health.controller.js';
import { SystemAdminModule } from './system-admin/system-admin.module.js';

@Module({
  imports: [DatabaseModule, SystemAdminModule],
  controllers: [HealthController],
})
export class AppModule {}

import { type DynamicModule, Module } from '@nestjs/common';
import type { Environment } from './config/environment.schema.js';
import { EnvironmentModule } from './config/environment.module.js';
import { DatabaseModule } from './database/database.module.js';
import { HealthController } from './observability/health.controller.js';
import { SystemAdminModule } from './system-admin/system-admin.module.js';
import { ApiKeysModule } from './api-keys/api-keys.module.js';

@Module({})
export class AppModule {
  static forRoot(environment: Environment): DynamicModule {
    return {
      controllers: [HealthController],
      imports: [
        EnvironmentModule.forRoot(environment),
        DatabaseModule,
        ApiKeysModule,
        SystemAdminModule,
      ],
      module: AppModule,
    };
  }
}

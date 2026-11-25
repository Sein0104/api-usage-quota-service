import { Module } from '@nestjs/common';
import { SYSTEM_ADMIN_TOKEN } from '../common/security/security.tokens.js';
import { ENVIRONMENT } from '../config/environment.module.js';
import type { Environment } from '../config/environment.schema.js';
import { ProjectsModule } from '../projects/projects.module.js';
import { SystemAdminController } from './system-admin.controller.js';
import { SystemAdminAuthenticator } from './system-admin-authenticator.service.js';
import { SystemAdminGuard } from './system-admin.guard.js';

@Module({
  controllers: [SystemAdminController],
  imports: [ProjectsModule],
  providers: [
    {
      inject: [ENVIRONMENT],
      provide: SYSTEM_ADMIN_TOKEN,
      useFactory: (environment: Environment): string =>
        environment.SYSTEM_ADMIN_TOKEN,
    },
    SystemAdminAuthenticator,
    SystemAdminGuard,
  ],
})
export class SystemAdminModule {}

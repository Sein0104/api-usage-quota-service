import { Module } from '@nestjs/common';
import { SYSTEM_ADMIN_TOKEN } from '../common/security/security.tokens.js';
import { ProjectsModule } from '../projects/projects.module.js';
import { SystemAdminController } from './system-admin.controller.js';
import { SystemAdminGuard } from './system-admin.guard.js';

@Module({
  controllers: [SystemAdminController],
  imports: [ProjectsModule],
  providers: [
    {
      provide: SYSTEM_ADMIN_TOKEN,
      useFactory: (): string => process.env.SYSTEM_ADMIN_TOKEN ?? '',
    },
    SystemAdminGuard,
  ],
})
export class SystemAdminModule {}

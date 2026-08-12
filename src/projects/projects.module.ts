import { Module } from '@nestjs/common';
import { ApiKeysModule } from '../api-keys/api-keys.module.js';
import { AuditModule } from '../audit/audit.module.js';
import { DatabaseModule } from '../database/database.module.js';
import { ProjectBootstrapService } from './project-bootstrap.service.js';

@Module({
  exports: [ProjectBootstrapService],
  imports: [DatabaseModule, ApiKeysModule, AuditModule],
  providers: [ProjectBootstrapService],
})
export class ProjectsModule {}

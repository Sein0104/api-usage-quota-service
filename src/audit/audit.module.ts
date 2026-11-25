import { Module } from '@nestjs/common';
import { ApiKeysModule } from '../api-keys/api-keys.module.js';
import { DatabaseModule } from '../database/database.module.js';
import { CursorCodec } from '../common/pagination/cursor-codec.js';
import { AuditController } from './audit.controller.js';
import { AuditReadRepository } from './audit-read.repository.js';
import { AuditService } from './audit.service.js';

@Module({
  controllers: [AuditController],
  imports: [ApiKeysModule, DatabaseModule],
  providers: [AuditReadRepository, AuditService, CursorCodec],
})
export class AuditModule {}

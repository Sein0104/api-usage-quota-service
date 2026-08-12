import { Module } from '@nestjs/common';
import { AuditWriteRepository } from './audit-write.repository.js';

@Module({
  exports: [AuditWriteRepository],
  providers: [AuditWriteRepository],
})
export class AuditModule {}

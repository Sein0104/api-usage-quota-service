import { Module } from '@nestjs/common';
import { ApiKeysModule } from '../api-keys/api-keys.module.js';
import { UsageController } from './usage.controller.js';
import { UsageRepository } from './usage.repository.js';
import { UsageService } from './usage.service.js';

@Module({
  controllers: [UsageController],
  imports: [ApiKeysModule],
  providers: [UsageRepository, UsageService],
})
export class UsageModule {}

import { Module } from '@nestjs/common';
import { ApiKeysModule } from '../api-keys/api-keys.module.js';
import { DailyUsageController, UsageController } from './usage.controller.js';
import { UsageRepository } from './usage.repository.js';
import { USAGE_QUOTA_TIME, UsageService } from './usage.service.js';
import { DailyUsageService } from './daily-usage.service.js';
import { IdempotencyRetry } from './idempotency-retry.js';
import { quotaTime } from './domain/quota-time.js';

@Module({
  controllers: [UsageController, DailyUsageController],
  imports: [ApiKeysModule],
  providers: [
    UsageRepository,
    UsageService,
    DailyUsageService,
    IdempotencyRetry,
    { provide: USAGE_QUOTA_TIME, useValue: quotaTime },
  ],
})
export class UsageModule {}

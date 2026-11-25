import { Injectable } from '@nestjs/common';
import type { AuthenticatedApiKey } from '../api-keys/auth/authenticated-api-key.js';
import { isDatabaseDependencyError } from '../common/database/dependency-error.js';
import { ProblemCode } from '../common/http/problem-code.js';
import { ProblemException } from '../common/http/problem.exception.js';
import { PrismaService } from '../database/prisma.service.js';
import type { DailyUsageRecord } from './daily-usage.presenter.js';
import { UsageRepository } from './usage.repository.js';

@Injectable()
export class DailyUsageService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly repository: UsageRepository,
  ) {}

  async list(
    actor: AuthenticatedApiKey,
    from: string,
    to: string,
  ): Promise<DailyUsageRecord[]> {
    try {
      return await this.repository.listDaily(
        this.prisma,
        actor.projectId,
        from,
        to,
      );
    } catch (error) {
      if (!isDatabaseDependencyError(error)) throw error;
      throw new ProblemException({
        code: ProblemCode.DEPENDENCY_UNAVAILABLE,
        detail: 'A required dependency is temporarily unavailable.',
        status: 503,
        title: 'Dependency unavailable',
      });
    }
  }
}

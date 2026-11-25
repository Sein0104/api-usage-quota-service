import { Injectable } from '@nestjs/common';
import type { AuthenticatedApiKey } from '../api-keys/auth/authenticated-api-key.js';
import { isDatabaseDependencyError } from '../common/database/dependency-error.js';
import { ProblemCode } from '../common/http/problem-code.js';
import { ProblemException } from '../common/http/problem.exception.js';
import { CursorCodec } from '../common/pagination/cursor-codec.js';
import {
  buildCursorPage,
  type PageRequest,
} from '../common/pagination/page.js';
import { PrismaService } from '../database/prisma.service.js';
import { AuditReadRepository } from './audit-read.repository.js';
import { presentAuditLog } from './audit.presenter.js';

@Injectable()
export class AuditService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly repository: AuditReadRepository,
    private readonly cursorCodec: CursorCodec = new CursorCodec(),
  ) {}

  async list(actor: AuthenticatedApiKey, page: PageRequest) {
    try {
      const rows = await this.repository.list(
        this.prisma,
        actor.projectId,
        page.cursor,
        page.limit + 1,
      );
      return buildCursorPage(rows.map(presentAuditLog), page.limit, (item) =>
        this.cursorCodec.encode({
          createdAt: new Date(item.createdAt),
          id: item.id,
        }),
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

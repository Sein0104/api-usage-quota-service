import { Injectable } from '@nestjs/common';
import { AuditWriteRepository } from '../audit/audit-write.repository.js';
import { ProblemCode } from '../common/http/problem-code.js';
import { ProblemException } from '../common/http/problem.exception.js';
import {
  ApiKeyStatus,
  type ApiKey,
  type Project,
} from '../generated/prisma/client.js';
import { ApiKeyCredentialService } from '../api-keys/api-key-credential.service.js';
import { INITIAL_ADMIN_SCOPES } from '../api-keys/api-key.presenter.js';
import { PrismaService } from '../database/prisma.service.js';

export interface ProjectBootstrapCommand {
  dailyQuotaUnits: number;
  name: string;
}

export interface ProjectBootstrapContext {
  requestId: string;
}

export interface ProjectBootstrapResult {
  apiKey: ApiKey;
  plaintext: string;
  project: Project;
}

function isKnownDependencyError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null || !('code' in error)) {
    return false;
  }
  const code = String(error.code);
  return new Set([
    'P1001',
    'P1002',
    'P1008',
    'P1017',
    '08000',
    '08003',
    '08006',
    '53300',
    '57P01',
    '57P02',
    '57P03',
  ]).has(code);
}

@Injectable()
export class ProjectBootstrapService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly credentials: ApiKeyCredentialService,
    private readonly auditWriter: AuditWriteRepository,
  ) {}

  async bootstrap(
    command: ProjectBootstrapCommand,
    context: ProjectBootstrapContext,
  ): Promise<ProjectBootstrapResult> {
    const issued = this.credentials.issue();

    try {
      return await this.prisma.$transaction(async (tx) => {
        const project = await tx.project.create({
          data: {
            dailyQuotaUnits: BigInt(command.dailyQuotaUnits),
            name: command.name,
          },
        });
        const apiKey = await tx.apiKey.create({
          data: {
            id: issued.id,
            name: 'initial-admin',
            prefix: issued.prefix,
            projectId: project.id,
            scopes: [...INITIAL_ADMIN_SCOPES],
            secretDigest: new Uint8Array(issued.digest),
            status: ApiKeyStatus.ACTIVE,
          },
        });

        await this.auditWriter.recordProjectCreated(tx, {
          dailyQuotaUnits: command.dailyQuotaUnits,
          initialApiKeyId: apiKey.id,
          projectId: project.id,
          projectName: project.name,
          requestId: context.requestId,
        });

        return { apiKey, plaintext: issued.plaintext, project };
      });
    } catch (error) {
      if (isKnownDependencyError(error)) {
        throw new ProblemException({
          code: ProblemCode.DEPENDENCY_UNAVAILABLE,
          detail: 'A required dependency is temporarily unavailable.',
          status: 503,
          title: 'Dependency unavailable',
        });
      }
      throw error;
    }
  }
}

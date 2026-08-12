import { Injectable } from '@nestjs/common';
import { AuditWriteRepository } from '../audit/audit-write.repository.js';
import { ProblemCode } from '../common/http/problem-code.js';
import { ProblemException } from '../common/http/problem.exception.js';
import { PrismaService } from '../database/prisma.service.js';
import { ApiKeyCredentialService } from './api-key-credential.service.js';
import type { AuthenticatedApiKey } from './auth/authenticated-api-key.js';
import type { ApiScope } from './api-key.scopes.js';
import { canonicalizeApiScopes } from './api-key.scopes.js';
import { ApiKeysRepository } from './api-keys.repository.js';

export interface CreateApiKeyCommand {
  name: string;
  scopes: ApiScope[];
}

export interface ApiKeyCreateContext {
  requestId: string;
}

export interface CreateApiKeyResult {
  apiKey: Awaited<ReturnType<ApiKeysRepository['create']>>;
  plaintext: string;
}

function isKnownDependencyError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null || !('code' in error)) {
    return false;
  }
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
  ]).has(String(error.code));
}

@Injectable()
export class ApiKeysService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly credentials: ApiKeyCredentialService,
    private readonly repository: ApiKeysRepository,
    private readonly auditWriter: AuditWriteRepository,
  ) {}

  async create(
    actor: AuthenticatedApiKey,
    command: CreateApiKeyCommand,
    context: ApiKeyCreateContext,
  ): Promise<CreateApiKeyResult> {
    const issued = this.credentials.issue();
    const scopes = canonicalizeApiScopes(command.scopes);
    try {
      return await this.prisma.$transaction(async (tx) => {
        await this.repository.lockProject(tx, actor.projectId);
        const activeCount = await this.repository.countActive(
          tx,
          actor.projectId,
        );
        if (activeCount >= 20) {
          throw new ProblemException({
            code: ProblemCode.ACTIVE_KEY_LIMIT_REACHED,
            detail: 'A project can have at most 20 active API keys.',
            status: 409,
            title: 'Active API key limit reached',
          });
        }
        const apiKey = await this.repository.create(tx, {
          digest: issued.digest,
          id: issued.id,
          name: command.name,
          prefix: issued.prefix,
          projectId: actor.projectId,
          scopes,
        });
        await this.auditWriter.recordApiKeyCreated(tx, {
          actorKeyId: actor.id,
          name: apiKey.name,
          prefix: apiKey.prefix,
          projectId: actor.projectId,
          requestId: context.requestId,
          resourceApiKeyId: apiKey.id,
          scopes: [...apiKey.scopes],
        });
        return { apiKey, plaintext: issued.plaintext };
      });
    } catch (error) {
      if (error instanceof ProblemException || !isKnownDependencyError(error)) {
        throw error;
      }
      throw new ProblemException({
        code: ProblemCode.DEPENDENCY_UNAVAILABLE,
        detail: 'A required dependency is temporarily unavailable.',
        status: 503,
        title: 'Dependency unavailable',
      });
    }
  }
}

import { Injectable } from '@nestjs/common';
import { AuditWriteRepository } from '../audit/audit-write.repository.js';
import { ProblemCode } from '../common/http/problem-code.js';
import { ProblemException } from '../common/http/problem.exception.js';
import { isDatabaseDependencyError } from '../common/database/dependency-error.js';
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

function validateCommand(command: CreateApiKeyCommand): ApiScope[] {
  if (
    typeof command.name !== 'string' ||
    command.name.length < 1 ||
    command.name.length > 100 ||
    command.name.trim() !== command.name
  )
    throw validationError();
  if (
    !Array.isArray(command.scopes) ||
    command.scopes.length < 1 ||
    command.scopes.length > 4 ||
    new Set(command.scopes).size !== command.scopes.length ||
    command.scopes.some(
      (scope) =>
        !['usage:write', 'usage:read', 'keys:manage', 'audit:read'].includes(
          scope,
        ),
    )
  )
    throw validationError();
  return canonicalizeApiScopes(command.scopes);
}
function validationError(): ProblemException {
  return new ProblemException({
    code: ProblemCode.VALIDATION_ERROR,
    detail: 'Request validation failed.',
    status: 400,
    title: 'Validation failed',
  });
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
    const scopes = validateCommand(command);
    const issued = this.credentials.issue();
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
      if (
        error instanceof ProblemException ||
        !isDatabaseDependencyError(error)
      ) {
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

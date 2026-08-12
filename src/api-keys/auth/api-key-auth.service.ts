import { Injectable } from '@nestjs/common';
import { Buffer } from 'node:buffer';
import { ApiKeyStatus } from '../../generated/prisma/client.js';
import { timingSafeBufferEqual } from '../../common/auth/timing-safe-secret.js';
import { ProblemCode } from '../../common/http/problem-code.js';
import { ProblemException } from '../../common/http/problem.exception.js';
import { PrismaService } from '../../database/prisma.service.js';
import { ApiKeyCredentialService } from '../api-key-credential.service.js';
import {
  canonicalizeApiScopes,
  isApiScope,
  type ApiScope,
} from '../api-key.scopes.js';
import type { AuthenticatedApiKey } from './authenticated-api-key.js';

const credentialPattern =
  /^mq_([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.([A-Za-z0-9_-]{43})$/;

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
export class ApiKeyAuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly credentials: ApiKeyCredentialService,
  ) {}

  async authenticate(
    rawCredential: string | undefined,
  ): Promise<AuthenticatedApiKey> {
    const match =
      rawCredential === undefined
        ? undefined
        : credentialPattern.exec(rawCredential);
    if (match === null || match === undefined) {
      throw this.invalidCredential();
    }

    try {
      // This is the sole unscoped API-key lookup: authentication has no tenant yet.
      const credential = rawCredential!;
      const row = await this.prisma.apiKey.findFirst({
        select: {
          id: true,
          projectId: true,
          scopes: true,
          secretDigest: true,
        },
        where: { id: match[1], status: ApiKeyStatus.ACTIVE },
      });
      if (
        row === null ||
        row.secretDigest.length !== 32 ||
        row.scopes.length < 1 ||
        row.scopes.length > 4 ||
        row.scopes.some((scope) => !isApiScope(scope)) ||
        new Set(row.scopes).size !== row.scopes.length ||
        !timingSafeBufferEqual(
          this.credentials.digest(credential),
          Buffer.from(row.secretDigest),
        )
      ) {
        throw this.invalidCredential();
      }

      const scopes = canonicalizeApiScopes(row.scopes);
      return Object.freeze({
        id: row.id,
        projectId: row.projectId,
        scopes: Object.freeze(scopes) as readonly ApiScope[],
      });
    } catch (error) {
      if (error instanceof ProblemException) {
        throw error;
      }
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

  private invalidCredential(): ProblemException {
    return new ProblemException({
      code: ProblemCode.INVALID_API_KEY,
      detail: 'The API key credential is invalid.',
      headers: { 'WWW-Authenticate': 'Bearer' },
      status: 401,
      title: 'Invalid API key',
    });
  }
}

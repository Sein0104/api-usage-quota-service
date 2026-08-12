import { Injectable } from '@nestjs/common';
import { Buffer } from 'node:buffer';
import { ApiKeyStatus } from '../../generated/prisma/client.js';
import { timingSafeBufferEqual } from '../../common/auth/timing-safe-secret.js';
import { ProblemCode } from '../../common/http/problem-code.js';
import { ProblemException } from '../../common/http/problem.exception.js';
import { PrismaService } from '../../database/prisma.service.js';
import { isDatabaseDependencyError } from '../../common/database/dependency-error.js';
import { ApiKeyCredentialService } from '../api-key-credential.service.js';
import {
  canonicalizeApiScopes,
  isApiScope,
  type ApiScope,
} from '../api-key.scopes.js';
import type { AuthenticatedApiKey } from './authenticated-api-key.js';

const credentialPattern =
  /^mq_([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.([A-Za-z0-9_-]{43})$/;

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
    const credential = rawCredential!;
    const secret = Buffer.from(match[2], 'base64url');
    if (secret.length !== 32 || secret.toString('base64url') !== match[2]) {
      throw this.invalidCredential();
    }
    const candidateDigest = this.credentials.digest(credential);

    try {
      // This is the sole unscoped API-key lookup: authentication has no tenant yet.
      const row = await this.prisma.apiKey.findFirst({
        select: {
          id: true,
          projectId: true,
          scopes: true,
          secretDigest: true,
        },
        where: { id: match[1], status: ApiKeyStatus.ACTIVE },
      });
      const storedDigest =
        row === null ? Buffer.alloc(32) : Buffer.from(row.secretDigest);
      const digestMatches = timingSafeBufferEqual(
        candidateDigest,
        storedDigest,
      );
      if (
        row === null ||
        row.secretDigest.length !== 32 ||
        row.scopes.length < 1 ||
        row.scopes.length > 4 ||
        row.scopes.some((scope) => !isApiScope(scope)) ||
        new Set(row.scopes).size !== row.scopes.length ||
        !digestMatches
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
      if (isDatabaseDependencyError(error)) {
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

import { Injectable } from '@nestjs/common';
import type { Buffer } from 'node:buffer';
import {
  ApiKeyStatus,
  Prisma,
  type ApiKey,
} from '../generated/prisma/client.js';
import type { ApiScope } from './api-key.scopes.js';

export interface CreateApiKeyRecord {
  digest: Buffer;
  id: string;
  name: string;
  prefix: string;
  projectId: string;
  scopes: ApiScope[];
}

@Injectable()
export class ApiKeysRepository {
  async lockProject(
    tx: Prisma.TransactionClient,
    projectId: string,
  ): Promise<void> {
    const projects = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM projects WHERE id = ${projectId}::uuid FOR UPDATE
    `;
    if (projects.length !== 1) {
      throw new Error('Authenticated API key references a missing project.');
    }
  }

  countActive(
    tx: Prisma.TransactionClient,
    projectId: string,
  ): Promise<number> {
    return tx.apiKey.count({
      where: { projectId, status: ApiKeyStatus.ACTIVE },
    });
  }

  create(
    tx: Prisma.TransactionClient,
    data: CreateApiKeyRecord,
  ): Promise<ApiKey> {
    return tx.apiKey.create({
      data: {
        id: data.id,
        name: data.name,
        prefix: data.prefix,
        projectId: data.projectId,
        scopes: data.scopes,
        secretDigest: new Uint8Array(data.digest),
        status: ApiKeyStatus.ACTIVE,
      },
    });
  }
}

import { Injectable } from '@nestjs/common';
import type { Buffer } from 'node:buffer';
import {
  ApiKeyStatus,
  Prisma,
  type ApiKey,
} from '../generated/prisma/client.js';
import type { ApiScope } from './api-key.scopes.js';
import type { CursorValue } from '../common/pagination/cursor-codec.js';

export interface ApiKeyMetadataRecord {
  id: string;
  name: string;
  prefix: string;
  scopes: string[];
  status: ApiKeyStatus;
  createdAt: Date;
  revokedAt: Date | null;
}

interface ApiKeyReadClient {
  $queryRaw<T>(query: TemplateStringsArray | Prisma.Sql): Promise<T>;
}

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

  list(
    client: ApiKeyReadClient,
    projectId: string,
    cursor: CursorValue | null,
    take: number,
  ): Promise<ApiKeyMetadataRecord[]> {
    const cursorClause =
      cursor === null
        ? Prisma.empty
        : Prisma.sql`AND (created_at, id) < (${cursor.createdAt}, ${cursor.id}::uuid)`;
    return client.$queryRaw<ApiKeyMetadataRecord[]>(Prisma.sql`
      SELECT
        id,
        name,
        prefix,
        scopes,
        status,
        created_at AS "createdAt",
        revoked_at AS "revokedAt"
      FROM api_keys
      WHERE project_id = ${projectId}::uuid
      ${cursorClause}
      ORDER BY created_at DESC, id DESC
      LIMIT ${take}
    `);
  }

  async lockForRevoke(
    tx: Prisma.TransactionClient,
    projectId: string,
    id: string,
  ): Promise<ApiKeyMetadataRecord | null> {
    const rows = await tx.$queryRaw<ApiKeyMetadataRecord[]>`
      SELECT
        id,
        name,
        prefix,
        scopes,
        status,
        created_at AS "createdAt",
        revoked_at AS "revokedAt"
      FROM api_keys
      WHERE project_id = ${projectId}::uuid AND id = ${id}::uuid
      FOR UPDATE
    `;
    return rows[0] ?? null;
  }

  async revoke(
    tx: Prisma.TransactionClient,
    projectId: string,
    id: string,
  ): Promise<void> {
    await tx.$executeRaw`
      UPDATE api_keys
      SET status = 'REVOKED'::api_key_status, revoked_at = now()
      WHERE project_id = ${projectId}::uuid AND id = ${id}::uuid
    `;
  }
}

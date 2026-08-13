import { Injectable } from '@nestjs/common';
import type { CursorValue } from '../common/pagination/cursor-codec.js';
import type { PrismaService } from '../database/prisma.service.js';
import type { AuditLogRecord } from './audit.presenter.js';

@Injectable()
export class AuditReadRepository {
  async list(
    database: PrismaService,
    projectId: string,
    cursor: CursorValue | null,
    take: number,
  ): Promise<AuditLogRecord[]> {
    if (cursor === null) {
      return database.$queryRaw<AuditLogRecord[]>`
        SELECT
          id,
          project_id AS "projectId",
          actor_key_id AS "actorKeyId",
          action,
          resource_api_key_id AS "resourceApiKeyId",
          request_id AS "requestId",
          metadata,
          created_at AS "createdAt"
        FROM audit_logs
        WHERE project_id = ${projectId}::uuid
        ORDER BY created_at DESC, id DESC
        LIMIT ${take}
      `;
    }
    return database.$queryRaw<AuditLogRecord[]>`
      SELECT
        id,
        project_id AS "projectId",
        actor_key_id AS "actorKeyId",
        action,
        resource_api_key_id AS "resourceApiKeyId",
        request_id AS "requestId",
        metadata,
        created_at AS "createdAt"
      FROM audit_logs
      WHERE project_id = ${projectId}::uuid
        AND (created_at, id) < (${cursor.createdAt}, ${cursor.id}::uuid)
      ORDER BY created_at DESC, id DESC
      LIMIT ${take}
    `;
  }
}

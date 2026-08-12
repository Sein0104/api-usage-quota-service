import { Injectable } from '@nestjs/common';
import { AuditAction, Prisma } from '../generated/prisma/client.js';

export interface ProjectCreatedAudit {
  dailyQuotaUnits: number;
  initialApiKeyId: string;
  projectId: string;
  projectName: string;
  requestId: string;
}

export interface ApiKeyCreatedAudit {
  actorKeyId: string;
  name: string;
  prefix: string;
  projectId: string;
  requestId: string;
  resourceApiKeyId: string;
  scopes: string[];
}

@Injectable()
export class AuditWriteRepository {
  async recordProjectCreated(
    tx: Prisma.TransactionClient,
    data: ProjectCreatedAudit,
  ): Promise<void> {
    await tx.auditLog.create({
      data: {
        action: AuditAction.PROJECT_CREATED,
        actorKeyId: null,
        metadata: {
          dailyQuotaUnits: data.dailyQuotaUnits,
          initialApiKeyId: data.initialApiKeyId,
          projectName: data.projectName,
        },
        projectId: data.projectId,
        requestId: data.requestId,
        resourceApiKeyId: null,
      },
    });
  }

  async recordApiKeyCreated(
    tx: Prisma.TransactionClient,
    data: ApiKeyCreatedAudit,
  ): Promise<void> {
    await tx.auditLog.create({
      data: {
        action: AuditAction.API_KEY_CREATED,
        actorKeyId: data.actorKeyId,
        metadata: {
          name: data.name,
          prefix: data.prefix,
          scopes: data.scopes,
        },
        projectId: data.projectId,
        requestId: data.requestId,
        resourceApiKeyId: data.resourceApiKeyId,
      },
    });
  }
}

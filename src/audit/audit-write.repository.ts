import { Injectable } from '@nestjs/common';
import { AuditAction, Prisma } from '../generated/prisma/client.js';

export interface ProjectCreatedAudit {
  dailyQuotaUnits: number;
  initialApiKeyId: string;
  projectId: string;
  projectName: string;
  requestId: string;
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
}

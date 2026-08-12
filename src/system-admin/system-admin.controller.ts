import {
  Body,
  Controller,
  HttpCode,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import { presentApiKey } from '../api-keys/api-key.presenter.js';
import { JsonContentTypeGuard } from '../common/http/json-content-type.guard.js';
import { CreateProjectDto } from '../projects/dto/create-project.dto.js';
import { presentProject } from '../projects/project.presenter.js';
import { ProjectBootstrapService } from '../projects/project-bootstrap.service.js';
import { SystemAdminGuard } from './system-admin.guard.js';

@Controller('admin/projects')
@UseGuards(SystemAdminGuard, JsonContentTypeGuard)
export class SystemAdminController {
  constructor(private readonly projects: ProjectBootstrapService) {}

  @Post()
  @HttpCode(201)
  async createProject(
    @Body() body: CreateProjectDto,
    @Req() request: Request,
  ): Promise<{
    apiKey: ReturnType<typeof presentApiKey>;
    project: ReturnType<typeof presentProject>;
    secret: string;
  }> {
    const result = await this.projects.bootstrap(body, request.requestContext!);
    return {
      apiKey: presentApiKey(result.apiKey),
      project: presentProject(result.project),
      secret: result.plaintext,
    };
  }
}

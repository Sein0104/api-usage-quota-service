import { Module } from '@nestjs/common';
import {
  API_KEY_CREDENTIAL_RANDOM,
  API_KEY_PEPPER,
  cryptoApiKeyCredentialRandom,
} from '../common/security/security.tokens.js';
import { ENVIRONMENT } from '../config/environment.module.js';
import type { Environment } from '../config/environment.schema.js';
import { AuditModule } from '../audit/audit.module.js';
import { DatabaseModule } from '../database/database.module.js';
import { ApiKeyCredentialService } from './api-key-credential.service.js';
import { ApiKeysController } from './api-keys.controller.js';
import { ApiKeyEarlyAuthorizer } from './api-key-early-authorizer.service.js';
import { ApiKeysRepository } from './api-keys.repository.js';
import { ApiKeysService } from './api-keys.service.js';
import { ApiKeyAuthGuard } from './auth/api-key-auth.guard.js';
import { ApiKeyAuthService } from './auth/api-key-auth.service.js';
import { ScopesGuard } from './auth/scopes.guard.js';
import { CursorCodec } from '../common/pagination/cursor-codec.js';

@Module({
  controllers: [ApiKeysController],
  exports: [
    ApiKeyAuthGuard,
    ApiKeyAuthService,
    ApiKeyCredentialService,
    ApiKeyEarlyAuthorizer,
    ScopesGuard,
  ],
  imports: [AuditModule, DatabaseModule],
  providers: [
    {
      inject: [ENVIRONMENT],
      provide: API_KEY_PEPPER,
      useFactory: (environment: Environment): string =>
        environment.API_KEY_PEPPER,
    },
    {
      provide: API_KEY_CREDENTIAL_RANDOM,
      useValue: cryptoApiKeyCredentialRandom,
    },
    ApiKeyCredentialService,
    ApiKeyAuthService,
    ApiKeyAuthGuard,
    ScopesGuard,
    ApiKeyEarlyAuthorizer,
    ApiKeysRepository,
    ApiKeysService,
    CursorCodec,
  ],
})
export class ApiKeysModule {}

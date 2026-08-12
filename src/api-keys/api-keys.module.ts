import { Module } from '@nestjs/common';
import {
  API_KEY_CREDENTIAL_RANDOM,
  API_KEY_PEPPER,
  cryptoApiKeyCredentialRandom,
} from '../common/security/security.tokens.js';
import { ENVIRONMENT } from '../config/environment.module.js';
import type { Environment } from '../config/environment.schema.js';
import { ApiKeyCredentialService } from './api-key-credential.service.js';

@Module({
  exports: [ApiKeyCredentialService],
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
  ],
})
export class ApiKeysModule {}

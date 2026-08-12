import { Module } from '@nestjs/common';
import {
  API_KEY_CREDENTIAL_RANDOM,
  API_KEY_PEPPER,
  cryptoApiKeyCredentialRandom,
} from '../common/security/security.tokens.js';
import { ApiKeyCredentialService } from './api-key-credential.service.js';

@Module({
  exports: [ApiKeyCredentialService],
  providers: [
    {
      provide: API_KEY_PEPPER,
      useFactory: (): string => process.env.API_KEY_PEPPER ?? '',
    },
    {
      provide: API_KEY_CREDENTIAL_RANDOM,
      useValue: cryptoApiKeyCredentialRandom,
    },
    ApiKeyCredentialService,
  ],
})
export class ApiKeysModule {}

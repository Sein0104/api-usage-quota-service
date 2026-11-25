import { Inject, Injectable } from '@nestjs/common';
import type { Buffer } from 'node:buffer';
import { createHmac } from 'node:crypto';
import {
  API_KEY_CREDENTIAL_RANDOM,
  API_KEY_PEPPER,
  type ApiKeyCredentialRandom,
} from '../common/security/security.tokens.js';

export interface IssuedApiKey {
  digest: Buffer;
  id: string;
  plaintext: string;
  prefix: string;
}

@Injectable()
export class ApiKeyCredentialService {
  constructor(
    @Inject(API_KEY_PEPPER) private readonly pepper: string,
    @Inject(API_KEY_CREDENTIAL_RANDOM)
    private readonly random: ApiKeyCredentialRandom,
  ) {}

  issue(): IssuedApiKey {
    const id = this.random.randomUUID();
    const prefix = `mq_${id}`;
    const secret = this.random.randomBytes(32).toString('base64url');
    const plaintext = `${prefix}.${secret}`;
    const digest = this.digest(plaintext);

    return { digest, id, plaintext, prefix };
  }

  digest(rawCredential: string): Buffer {
    return createHmac('sha256', this.pepper)
      .update(rawCredential, 'utf8')
      .digest();
  }
}

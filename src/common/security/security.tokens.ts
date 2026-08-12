import { randomBytes, randomUUID } from 'node:crypto';
import type { Buffer } from 'node:buffer';

export const SYSTEM_ADMIN_TOKEN = Symbol('SYSTEM_ADMIN_TOKEN');
export const API_KEY_PEPPER = Symbol('API_KEY_PEPPER');
export const API_KEY_CREDENTIAL_RANDOM = Symbol('API_KEY_CREDENTIAL_RANDOM');

export interface ApiKeyCredentialRandom {
  randomBytes(size: number): Buffer;
  randomUUID(): string;
}

export const cryptoApiKeyCredentialRandom: ApiKeyCredentialRandom = {
  randomBytes,
  randomUUID,
};

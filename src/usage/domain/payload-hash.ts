import { createHash } from 'node:crypto';
import { Buffer } from 'node:buffer';

export function payloadHash(units: number): Buffer {
  return createHash('sha256')
    .update(`usage-event:v1:${units}`, 'utf8')
    .digest();
}

import { createHash, timingSafeEqual } from 'node:crypto';
import { Buffer } from 'node:buffer';

function digest(value: string) {
  return createHash('sha256').update(value, 'utf8').digest();
}

export function timingSafeBufferEqual(left: Buffer, right: Buffer): boolean {
  if (left.length !== right.length) {
    return false;
  }
  try {
    return timingSafeEqual(left, right);
  } catch {
    return false;
  }
}

export function timingSafeSecretEqual(left: string, right: string): boolean {
  return timingSafeBufferEqual(digest(left), digest(right));
}

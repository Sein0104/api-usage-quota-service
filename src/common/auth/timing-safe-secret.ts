import { createHash, timingSafeEqual } from 'node:crypto';

function digest(value: string) {
  return createHash('sha256').update(value, 'utf8').digest();
}

export function timingSafeSecretEqual(left: string, right: string): boolean {
  try {
    return timingSafeEqual(digest(left), digest(right));
  } catch {
    return false;
  }
}
